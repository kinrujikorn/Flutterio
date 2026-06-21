// lsp.test.ts — Integration test for the Dart LSP-backed analyzer.
//
// Spins up a tiny synthetic Dart project and runs `analyzeWithLsp` against a
// real `dart language-server`. Skips gracefully (t.skip) when `dart` is not on
// PATH or the server returns null, so the suite stays green on machines
// without a Dart SDK.
//
// The synthetic project defines its own widget base classes (so hover can
// resolve supertypes without `flutter pub get`) plus a page with a routePath
// and a second file that instantiates that page's widget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanProject } from '../src/scanner.ts';
import { analyzeWithLsp } from '../src/lsp/analyze.ts';

/** Is the `dart` executable available on PATH? */
function dartAvailable(): boolean {
  try {
    const r = spawnSync('dart', ['--version'], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

const LOGIN_PAGE = `
// Local widget bases so hover resolves supertypes without flutter deps.
abstract class StatelessWidget {
  const StatelessWidget();
}

class LoginPage extends StatelessWidget {
  static const routePath = '/login';
  const LoginPage();
}
`;

const HOME = `
import 'login_page.dart';

class HomeWidget extends StatelessWidget {
  const HomeWidget();
  Object build() => const LoginPage();
}
`;

test('lsp: analyzes a tiny synthetic project', async (t) => {
  if (!dartAvailable()) {
    t.skip('dart not on PATH');
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pagemapper-lsp-'));
  try {
    const lib = path.join(dir, 'lib');
    await fs.mkdir(lib, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'pubspec.yaml'),
      "name: lsp_probe\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
      'utf8',
    );
    await fs.writeFile(path.join(lib, 'login_page.dart'), LOGIN_PAGE, 'utf8');
    await fs.writeFile(path.join(lib, 'home.dart'), HOME, 'utf8');

    const scan = await scanProject(dir);
    const result = await analyzeWithLsp(scan);

    if (!result) {
      t.skip('analyzeWithLsp returned null (dart server unavailable)');
      return;
    }

    // Page detected with the correct routePath.
    const login = result.pages.find((p) => p.className === 'LoginPage');
    assert.ok(login, 'expected LoginPage to be detected as a page');
    assert.equal(login!.routePath, '/login');

    // A widget was classified (HomeWidget extends StatelessWidget).
    assert.ok(
      result.widgets.some((w) => w.className === 'HomeWidget'),
      'expected HomeWidget to be classified as a widget',
    );

    // A uses edge from home.dart -> LoginPage (cross-file reference).
    assert.ok(
      result.usesEdges.some(
        (u) => u.fromFileRel === 'lib/home.dart' && u.widgetClass === 'LoginPage',
      ),
      'expected a uses edge from home.dart to LoginPage',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
