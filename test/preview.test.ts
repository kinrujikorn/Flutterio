// preview.test.ts — Unit tests for the deterministic widget-tree renderer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPreview, type PreviewContext } from '../src/preview.ts';

/** Build a PreviewContext from partial overrides; all hooks default to null. */
function ctx(overrides: Partial<PreviewContext> = {}): PreviewContext {
  return {
    resolveClass: () => null,
    colorToken: () => null,
    localize: () => null,
    ...overrides,
  };
}

function isDoc(html: string): boolean {
  return html.startsWith('<!doctype') && html.includes('<style>') && html.includes('</html>');
}

test('preview: Scaffold + AppBar + Column with Text and ElevatedButton', () => {
  const dart = `
    class HomePage extends StatelessWidget {
      @override
      Widget build(BuildContext context) {
        return Scaffold(
          appBar: AppBar(title: Text('My Title')),
          body: Column(
            children: [
              Text('Hello world'),
              ElevatedButton(
                onPressed: () {},
                child: Text('Tap me'),
              ),
            ],
          ),
        );
      }
    }
  `;
  const html = renderPreview('home_page.dart', dart);
  assert.ok(isDoc(html), 'is a complete HTML document');
  assert.match(html, /My Title/);
  assert.match(html, /Hello world/);
  assert.match(html, /Tap me/);
  assert.match(html, /btn-filled/);
  assert.match(html, /class="appbar"/);
});

test('preview: dynamic Text(variable) renders a placeholder, does not crash', () => {
  const dart = `
    class ProfilePage extends StatelessWidget {
      Widget build(BuildContext context) {
        return Text(userName);
      }
    }
  `;
  const html = renderPreview('profile_page.dart', dart);
  assert.ok(isDoc(html));
  assert.match(html, /t-dyn/, 'dynamic text becomes a muted placeholder');
});

test('preview: unknown custom widget is a labeled box and recurses into child', () => {
  const dart = `
    class ThingPage extends StatelessWidget {
      Widget build(BuildContext context) {
        return MyCustomThing(child: Text('hi'));
      }
    }
  `;
  const html = renderPreview('thing_page.dart', dart);
  assert.ok(isDoc(html));
  assert.match(html, /MyCustomThing/, 'custom widget name appears as a label');
  assert.match(html, />hi</, 'recursed child Text is rendered');
});

test('preview: no parseable build() returns a friendly doc without throwing', () => {
  const dart = `
    class NotAWidget {
      int add(int a, int b) => a + b;
    }
  `;
  let html = '';
  assert.doesNotThrow(() => {
    html = renderPreview('helper.dart', dart);
  });
  assert.ok(isDoc(html), 'still a valid HTML document');
  assert.match(html, /Preview unavailable/);
});

test('preview: arrow-bodied build() is supported', () => {
  const dart = `
    class QuickPage extends StatelessWidget {
      Widget build(BuildContext context) => Center(child: Text('Centered'));
    }
  `;
  const html = renderPreview('quick_page.dart', dart);
  assert.ok(isDoc(html));
  assert.match(html, /Centered/);
  assert.match(html, /class="center"/);
});

test('preview: prefers a *Page class build over other widgets', () => {
  const dart = `
    class HelperWidget extends StatelessWidget {
      Widget build(BuildContext context) => Text('helper');
    }
    class MainPage extends StatelessWidget {
      Widget build(BuildContext context) => Text('the page');
    }
  `;
  const html = renderPreview('main_page.dart', dart);
  assert.match(html, /the page/);
  assert.doesNotMatch(html, /helper/);
});

test('preview: TextField uses hintText literal', () => {
  const dart = `
    class FormPage extends StatelessWidget {
      Widget build(BuildContext context) =>
          TextField(decoration: InputDecoration(hintText: 'Email'));
    }
  `;
  const html = renderPreview('form_page.dart', dart);
  assert.match(html, /Email/);
  assert.match(html, /class="input"/);
});

test('preview: ListView.builder renders repeated placeholder rows', () => {
  const dart = `
    class FeedPage extends StatelessWidget {
      Widget build(BuildContext context) => ListView.builder(
        itemBuilder: (context, i) => ListTile(title: Text('row')),
      );
    }
  `;
  const html = renderPreview('feed_page.dart', dart);
  const rows = (html.match(/list-row/g) ?? []).length;
  assert.ok(rows >= 3, `expected >=3 placeholder rows, got ${rows}`);
});

test('preview: sees through a generic builder closure (BlocBuilder)', () => {
  const dart = `
    class LoginPage extends StatelessWidget {
      Widget build(BuildContext context) => Column(
        children: [
          BlocBuilder<LoginCubit, LoginState>(
            buildWhen: (p, c) => p.email != c.email,
            builder: (context, state) => TextField(
              decoration: InputDecoration(hintText: 'Email'),
            ),
          ),
          BlocBuilder<LoginCubit, LoginState>(
            builder: (context, state) => ElevatedButton(
              onPressed: () {},
              child: Text('Sign In'),
            ),
          ),
        ],
      );
    }
  `;
  const html = renderPreview('login_page.dart', dart);
  assert.match(html, /Email/, 'input from builder closure renders');
  assert.match(html, /Sign In/, 'button from builder closure renders');
  assert.match(html, /class="input"/);
  assert.match(html, /btn-filled/);
});

test('preview: falls back from a thin *Page wrapper to the rich sibling build', () => {
  // LoginPage.build only wraps a private _LoginView; the real screen is there.
  const dart = `
    class LoginPage extends StatelessWidget {
      Widget build(BuildContext context) =>
          BlocProvider(create: (c) => c.read(), child: _LoginView());
    }
    class _LoginView extends StatelessWidget {
      Widget build(BuildContext context) => Scaffold(
        body: Column(children: [Text('Welcome back'), TextField()]),
      );
    }
  `;
  const html = renderPreview('login_page.dart', dart);
  assert.match(html, /Welcome back/, 'rich sibling build is used');
  assert.match(html, /class="input"/);
});

test('preview: deterministic — same input yields same output', () => {
  const dart = `class P extends StatelessWidget { Widget build(c) => Text('x'); }`;
  assert.equal(renderPreview('p.dart', dart), renderPreview('p.dart', dart));
});

// ---------------------------------------------------------------------------
// ctx: recursive custom-widget resolution
// ---------------------------------------------------------------------------

test('preview: ctx resolves a custom widget into its real build tree', () => {
  const dart = `
    class GoPage extends StatelessWidget {
      Widget build(BuildContext context) => MyButton(label: 'Go');
    }
  `;
  const myButton = `
    class MyButton extends StatelessWidget {
      Widget build(c) => ElevatedButton(onPressed: () {}, child: Text('Go'));
    }
  `;
  const html = renderPreview('go_page.dart', dart, ctx({
    resolveClass: (n) => (n === 'MyButton' ? myButton : null),
  }));
  assert.match(html, /btn-filled/, 'renders a real button, not a MyButton box');
  assert.doesNotMatch(html, /class="generic"/, 'no generic fallback box');
  assert.match(html, />Go</, 'inner Text renders');
});

test('preview: without ctx, custom widget stays a generic labeled box', () => {
  const dart = `
    class GoPage extends StatelessWidget {
      Widget build(BuildContext context) => MyButton(label: 'Go');
    }
  `;
  const html = renderPreview('go_page.dart', dart);
  assert.match(html, /MyButton/, 'custom widget name appears as a label');
  assert.match(html, /class="generic"/);
});

test('preview: self-referential custom widget terminates (cycle guard)', () => {
  const dart = `
    class LoopPage extends StatelessWidget {
      Widget build(BuildContext context) => Loop();
    }
  `;
  const loop = `class Loop extends StatelessWidget { Widget build(c) => Loop(); }`;
  let html = '';
  assert.doesNotThrow(() => {
    html = renderPreview('loop_page.dart', dart, ctx({
      resolveClass: (n) => (n === 'Loop' ? loop : null),
    }));
  });
  assert.ok(isDoc(html), 'terminates with a valid HTML document');
});

test('preview: deeply nested custom widgets stop at the depth cap', () => {
  // A -> B -> C -> ... each resolving to the next; never throws/hangs.
  const dart = `class P extends StatelessWidget { Widget build(c) => W0(); }`;
  const html = renderPreview('p.dart', dart, ctx({
    resolveClass: (n) => {
      const m = /^W(\d+)$/.exec(n);
      if (!m) return null;
      const next = Number(m[1]) + 1;
      return `class ${n} extends StatelessWidget { Widget build(c) => W${next}(); }`;
    },
  }));
  assert.ok(isDoc(html), 'terminates with a valid HTML document');
});

test('preview: param-forwarding wrapper keeps call-site children', () => {
  // Wrap's build just forwards `child`; resolving it would drop the real child,
  // so the renderer falls back to the generic box that recurses into it.
  const dart = `
    class P extends StatelessWidget {
      Widget build(c) => Wrap2(child: Text('kept'));
    }
  `;
  const wrap2 = `
    class Wrap2 extends StatelessWidget {
      Widget build(c) => Semantics(label: 'x', child: child);
    }
  `;
  const html = renderPreview('p.dart', dart, ctx({
    resolveClass: (n) => (n === 'Wrap2' ? wrap2 : null),
  }));
  assert.match(html, />kept</, 'call-site child survives the wrapper');
});

// ---------------------------------------------------------------------------
// ctx: real colors
// ---------------------------------------------------------------------------

test('preview: ctx.colorToken paints a Container background', () => {
  const dart = `
    class P extends StatelessWidget {
      Widget build(c) => Container(color: VenColors.primary, child: Text('hi'));
    }
  `;
  const html = renderPreview('p.dart', dart, ctx({
    colorToken: (n) => (n === 'primary' ? '#116DFC' : null),
  }));
  assert.match(html, /#116dfc/i, 'resolved brand color appears in style');
});

test('preview: Color(0xAARRGGBB) literal converts to CSS hex', () => {
  const dart = `
    class P extends StatelessWidget {
      Widget build(c) => Container(color: Color(0xFF112233), child: Text('hi'));
    }
  `;
  const html = renderPreview('p.dart', dart, ctx());
  assert.match(html, /#112233/i, 'color literal becomes hex');
});

test('preview: BoxDecoration(color:) paints a DecoratedBox background', () => {
  const dart = `
    class P extends StatelessWidget {
      Widget build(c) => DecoratedBox(
        decoration: BoxDecoration(color: Color(0xFFAABBCC)),
        child: Text('hi'),
      );
    }
  `;
  const html = renderPreview('p.dart', dart, ctx());
  assert.match(html, /#aabbcc/i);
});

test('preview: text color from .copyWith(color:) resolves via token', () => {
  const dart = `
    class P extends StatelessWidget {
      Widget build(c) => Text('hi', style: VenTypography.body.copyWith(color: VenColors.primary));
    }
  `;
  const html = renderPreview('p.dart', dart, ctx({
    colorToken: (n) => (n === 'primary' ? '#116DFC' : null),
  }));
  assert.match(html, /color:#116dfc/i);
});

// ---------------------------------------------------------------------------
// ctx: localized text
// ---------------------------------------------------------------------------

test('preview: localized key humanizes when ctx.localize returns null', () => {
  const dart = `
    class P extends StatelessWidget {
      Widget build(c) => Text(context.t('auth.login.sign_in'));
    }
  `;
  const html = renderPreview('p.dart', dart, ctx());
  assert.match(html, /Sign In/, 'humanized last segment');
});

test('preview: localized key uses ctx.localize when it returns a string', () => {
  const dart = `
    class P extends StatelessWidget {
      Widget build(c) => Text(context.t('x'));
    }
  `;
  const html = renderPreview('p.dart', dart, ctx({ localize: () => 'Custom' }));
  assert.match(html, /Custom/);
});

test('preview: tr() and .tr() localization forms are recognized', () => {
  const a = renderPreview(
    'a.dart',
    `class P extends StatelessWidget { Widget build(c) => Text(tr('a.b.hello_world')); }`,
    ctx(),
  );
  const b = renderPreview(
    'b.dart',
    `class P extends StatelessWidget { Widget build(c) => Text('a.b.hello_world'.tr()); }`,
    ctx(),
  );
  assert.match(a, /Hello World/);
  assert.match(b, /Hello World/);
});

test('preview: without ctx, a localized key stays a dynamic placeholder', () => {
  const dart = `
    class P extends StatelessWidget {
      Widget build(c) => Text(context.t('auth.login.sign_in'));
    }
  `;
  const html = renderPreview('p.dart', dart);
  assert.match(html, /t-dyn/, 'no humanization without ctx');
  assert.doesNotMatch(html, /Sign In/);
});
