# Component tests

Vitest + [`@testing-library/svelte`](https://testing-library.com/docs/svelte-testing-library/intro)
+ [`happy-dom`](https://github.com/capricorn86/happy-dom). Same runner as
the unit suite — `pnpm test` runs both. Per-file environment header is
all that distinguishes a component test from a unit test.

## Writing a test

Mirror the existing tests in this directory. The shape:

```ts
/* @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import MyComponent from '$lib/components/MyComponent.svelte';

describe('MyComponent', () => {
  it('does the thing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(MyComponent, { props: { value: 'hi', onChange } });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onChange).toHaveBeenCalledWith('hi');
  });
});
```

What the boilerplate gives you for free:

- **DOM cleanup between tests** — the `svelteTesting()` vite plugin
  wires this up automatically (see `vitest.config.ts`).
- **jest-dom matchers** — `toBeInTheDocument`, `toHaveAttribute`,
  `toHaveTextContent`, etc. are registered globally in
  `tests/component/_setup.ts`.
- **`$lib/*` alias resolution** — the same sveltekit() vite plugin the
  unit suite uses.

## Gotchas worth knowing

**bits-ui Portal**. Components rendered through `Popover.Portal`,
`Dialog.Portal`, etc. land in `document.body`, *not* in the original
render container. Use `screen.*` queries
(`screen.getByRole`, `screen.getByLabelText`) instead of
`container.querySelector(...)`, since `screen` looks at the entire
document. The `FeatureTogglesMenu.test.ts` opens a popover and
queries content this way — copy from there.

**bits-ui state attributes**. Switches and other stateful bits-ui
primitives carry `data-state="checked|unchecked|open|closed"` that
flips synchronously even when CSS transitions would defer the
*visual* state. Assert against the attribute, not against visibility:

```ts
expect(sw).toHaveAttribute('data-state', 'checked');
```

**Use `userEvent`, not `fireEvent`, for clicks**. The bits-ui Popover
focus trap and outside-click handling expect a realistic
pointerdown → pointerup → click → focus sequence. `userEvent.click()`
gives you that; bare `fireEvent.click()` skips the intermediate
events and can leave focus state inconsistent.

**happy-dom is partial**. `getBoundingClientRect`, scroll lock, some
`pointer:*` media query stuff are stubbed loosely. If a future test
flakes on one of these, mock the specific API rather than reaching
for the (heavier) jsdom alternative — and if the case genuinely
needs a real browser engine, that's what the Playwright e2e suite
(roadmap item) is for. Component tests live at the unit-isolation
layer; e2e tests live at the integration layer.

**`derived_inert` warnings are filtered**. `_setup.ts` swallows
Svelte 5's `derived_inert` warnings, which fire dozens of times per
test from bits-ui's Popover / Switch internals during teardown in
happy-dom. The warning means "a `$derived` was read after its
owning effect was destroyed" — harmless during teardown (nothing
observable reads the stale value), but the noise drowns out
warnings worth seeing. The filter is string-matched, narrow, and
documented inline at the suppression site; *all other* warnings —
including any `derived_inert` that fires in dev / browser from
code we wrote — surface normally. Drop the filter when bits-ui or
Svelte addresses the underlying source.

**`$app/*` mocking**. SvelteKit's `$app/state`, `$app/navigation`, and
friends aren't auto-stubbed. The first component test that imports a
component depending on them will need something like:

```ts
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/'), data: {} }
}));
```

Doing it once and exporting from a helper here is fine when more than
one test needs the same stub.

**`$state` mutations need `await tick()` before assertions**. Svelte 5
batches reactive updates, so directly mutating a `$state` field (e.g.
`confirmDialog.ask({...})` setting `pending`) doesn't synchronously
update the DOM. Tests that mutate state outside a user-event need to
`await tick()` from `'svelte'` before asserting against the rendered
output. `user.click()` and friends handle their own flushing.
