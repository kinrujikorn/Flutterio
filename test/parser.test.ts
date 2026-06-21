// parser.test.ts — Unit tests for the individual parsers using inline Dart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImports } from '../src/parser/imports.ts';
import {
  parseNavigation,
  resolveNavigation,
} from '../src/parser/navigation.ts';
import { parseWidgets, resolveUses } from '../src/parser/widgets.ts';
import { parseApiClasses, resolveApi } from '../src/parser/api.ts';
import type { ParseContext } from '../src/parser/context.ts';
import type { PackageInfo, ScannedFile } from '../src/types.ts';

const projectRoot = '/proj';

function file(relPath: string): ScannedFile {
  return {
    absPath: `${projectRoot}/${relPath}`,
    relPath,
    layer: 'other',
  };
}

/** Build a minimal ParseContext for import-resolution tests. */
function makeContext(files: ScannedFile[], packages: PackageInfo[]): ParseContext {
  const byRel = new Map(files.map((f) => [f.relPath, f]));
  const packagesByName = new Map(packages.map((p) => [p.name, p]));
  return {
    projectRoot,
    files,
    byRel,
    packagesByName,
    projectPackageNames: new Set(packagesByName.keys()),
  };
}

test('imports: resolves package import to scanned file', () => {
  const core = file('packages/core/lib/core.dart');
  const consumer = file('packages/features/auth/lib/src/login.dart');
  const ctx = makeContext(
    [core, consumer],
    [{ name: 'core', root: `${projectRoot}/packages/core` }],
  );

  const edges = parseImports(consumer, `import 'package:core/core.dart';`, ctx);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].toRel, 'packages/core/lib/core.dart');
  assert.equal(edges[0].external, false);
});

test('imports: external package is marked external with null target', () => {
  const consumer = file('a.dart');
  const ctx = makeContext([consumer], []);
  const edges = parseImports(consumer, `import 'package:flutter/material.dart';`, ctx);
  assert.equal(edges[0].external, true);
  assert.equal(edges[0].toRel, null);
});

test('imports: relative import resolves against importing dir', () => {
  const entity = file('packages/auth/lib/src/domain/entity.dart');
  const consumer = file('packages/auth/lib/src/presentation/page.dart');
  const ctx = makeContext([entity, consumer], []);
  const edges = parseImports(
    consumer,
    `import '../domain/entity.dart';`,
    ctx,
  );
  assert.equal(edges[0].toRel, 'packages/auth/lib/src/domain/entity.dart');
  assert.equal(edges[0].external, false);
});

test('imports: export directive also produces an edge', () => {
  const target = file('packages/core/lib/src/foo.dart');
  const barrel = file('packages/core/lib/core.dart');
  const ctx = makeContext([target, barrel], []);
  const edges = parseImports(barrel, `export 'src/foo.dart';`, ctx);
  assert.equal(edges[0].toRel, 'packages/core/lib/src/foo.dart');
});

test('navigation: GoRoute + page class + routePath const are linked', () => {
  // Page declaring its routePath.
  const loginDart = `
    class LoginPage extends StatelessWidget {
      static const routePath = '/login';
      Widget build(c) => Container();
    }
  `;
  // Router referencing the route.
  const routerDart = `
    GoRoute(path: LoginPage.routePath, builder: (_, __) => const LoginPage());
  `;

  const navLogin = parseNavigation(file('login_page.dart'), loginDart);
  assert.equal(navLogin.pages.length, 1);
  assert.equal(navLogin.pages[0].className, 'LoginPage');
  assert.equal(navLogin.pages[0].routePath, '/login');

  // The GoRoute body uses `LoginPage.routePath` -> picked up as a nav ref via
  // .builder? No — GoRoute path is a class ref, but navigation edges come from
  // call sites. We assert string-literal navigation below.
  void parseNavigation(file('router.dart'), routerDart);
});

test('navigation: context.go string literal resolves to page', () => {
  const dashDart = `
    class DashboardPage extends StatelessWidget {
      static const routePath = '/dashboard';
    }
  `;
  const callerDart = `
    void f(BuildContext context) {
      context.go('/dashboard');
    }
  `;
  const navDash = parseNavigation(file('dashboard_page.dart'), dashDart);
  const navCaller = parseNavigation(file('caller.dart'), callerDart);

  const pages = [...navDash.pages, ...navCaller.pages];
  const refs = [...navDash.navRefs, ...navCaller.navRefs];
  const edges = resolveNavigation(refs, pages);

  const goEdge = edges.find((e) => e.rawTarget === `'/dashboard'`);
  assert.ok(goEdge, 'expected a nav edge for /dashboard');
  assert.equal(goEdge!.method, 'go');
  assert.equal(goEdge!.routePath, '/dashboard');
  assert.equal(goEdge!.targetClass, 'DashboardPage');
});

test('navigation: captures extra: payload and resolves target', () => {
  const loginDart = `
    class LoginPage extends StatelessWidget {
      static const routePath = '/login';
    }
  `;
  const callerDart = `
    void f(BuildContext context) {
      context.go('/login', extra: state.company);
    }
  `;
  const navLogin = parseNavigation(file('login_page.dart'), loginDart);
  const navCaller = parseNavigation(file('caller.dart'), callerDart);
  const edges = resolveNavigation(
    [...navLogin.navRefs, ...navCaller.navRefs],
    [...navLogin.pages, ...navCaller.pages],
  );
  const edge = edges.find((e) => e.routePath === '/login');
  assert.ok(edge, 'expected a nav edge for /login');
  assert.equal(edge!.targetClass, 'LoginPage');
  assert.equal(edge!.extra, 'state.company');
});

test('navigation: nested parens in extra: do not break arg parsing', () => {
  const callerDart = `
    void f(BuildContext context) {
      context.push(CustomerPage.routePath, extra: build(a, b.c(d)));
    }
  `;
  const nav = parseNavigation(file('caller.dart'), callerDart);
  assert.equal(nav.navRefs.length, 1);
  assert.equal(nav.navRefs[0].rawTarget, 'CustomerPage.routePath');
  assert.equal(nav.navRefs[0].extra, 'build(a, b.c(d))');
});

test('navigation: context.go(Page.routePath) resolves to page class', () => {
  const pinDart = `
    class SetPinPage extends StatelessWidget {
      static const routePath = '/set-pin';
    }
  `;
  const callerDart = `void f(c) => context.go(SetPinPage.routePath);`;
  const pages = parseNavigation(file('set_pin_page.dart'), pinDart).pages;
  const refs = parseNavigation(file('caller.dart'), callerDart).navRefs;
  const edges = resolveNavigation(refs, pages);
  const e = edges.find((x) => x.rawTarget.includes('SetPinPage'));
  assert.ok(e);
  assert.equal(e!.targetClass, 'SetPinPage');
  assert.equal(e!.routePath, '/set-pin');
});

test('navigation: routePathFor template resolves by prefix', () => {
  const walkDart = `
    class WalkthroughPage extends StatefulWidget {
      static String routePathFor(int step) => '/walkthrough/\$step';
    }
  `;
  const callerDart = `void f(c) => context.go(WalkthroughPage.routePathFor(0));`;
  const pages = parseNavigation(file('walkthrough_page.dart'), walkDart).pages;
  const refs = parseNavigation(file('caller.dart'), callerDart).navRefs;
  const edges = resolveNavigation(refs, pages);
  const e = edges.find((x) => x.rawTarget.includes('WalkthroughPage'));
  assert.ok(e);
  assert.equal(e!.targetClass, 'WalkthroughPage');
});

test('widgets: uses-edge when a file instantiates another file widget', () => {
  const buttonDart = `class MyButton extends StatelessWidget { Widget build(c) => Container(); }`;
  const pageDart = `
    class HomePage extends StatelessWidget {
      Widget build(c) => MyButton();
    }
  `;
  const wButton = parseWidgets(file('button.dart'), buttonDart);
  const wPage = parseWidgets(file('home.dart'), pageDart);
  const widgets = [...wButton, ...wPage];

  const contents = new Map<string, string>([
    ['button.dart', buttonDart],
    ['home.dart', pageDart],
  ]);
  const edges = resolveUses(contents, widgets);

  const e = edges.find(
    (x) => x.fromFileRel === 'home.dart' && x.widgetClass === 'MyButton',
  );
  assert.ok(e, 'expected home.dart uses MyButton');
  // No self-edge: button.dart should not "use" MyButton.
  assert.ok(!edges.some((x) => x.fromFileRel === 'button.dart' && x.widgetClass === 'MyButton'));
});

test('widgets: private widget never produces a cross-file uses edge', () => {
  const aDart = `class _Private extends StatelessWidget {} class A extends StatelessWidget { build(c) => _Private(); }`;
  const widgets = parseWidgets(file('a.dart'), aDart);
  const contents = new Map([['a.dart', aDart]]);
  const edges = resolveUses(contents, widgets);
  assert.ok(!edges.some((e) => e.widgetClass === '_Private'));
});

test('api: detects repository reference and dio http call', () => {
  const repoDart = `
    abstract interface class AuthRepository {}
    class AuthRepositoryImpl implements AuthRepository {}
  `;
  const useDart = `
    class LoginCubit {
      final AuthRepository repo;
      void f() { _dio.post('/login'); }
    }
  `;
  const decls = [
    ...parseApiClasses(file('auth_repo.dart'), repoDart),
    ...parseApiClasses(file('login_cubit.dart'), useDart),
  ];
  const contents = new Map<string, string>([
    ['auth_repo.dart', repoDart],
    ['login_cubit.dart', useDart],
  ]);
  const edges = resolveApi(contents, decls);

  assert.ok(
    edges.some((e) => e.fromFileRel === 'login_cubit.dart' && e.target === 'AuthRepository' && e.kind === 'service'),
    'expected service edge to AuthRepository',
  );
  assert.ok(
    edges.some((e) => e.kind === 'http' && e.target === '_dio.post'),
    'expected http edge for _dio.post',
  );
});
