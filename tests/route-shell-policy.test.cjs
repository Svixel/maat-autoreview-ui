"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { globToRegExp, resolveShellPolicy } = require("../scripts/route-shell-policy.cjs");

function write(root, file, source) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-shell-policy-"));
  write(root, "src/ui/atoms/index.ts", "export { ScreenHeader } from './ScreenHeader';\n");
  write(root, "src/ui/atoms/ScreenHeader.tsx", "export default function ScreenHeader() { return null; }\n");
  for (const [file, source] of Object.entries(files)) write(root, file, source);
  return root;
}

function resolve(root, route = "/screen", sourceFile = "app/Route.tsx", exceptions = []) {
  return resolveShellPolicy({
    root,
    targets: [{ id: "screen", route, sourceFiles: [sourceFile] }],
    barrels: ["src/ui/atoms/index.ts"],
    shellPolicy: [{
      routeClass: "sub-screen",
      match: ["/**"],
      require: ["ScreenHeader", "ScrollViewHeader"],
      exceptions,
    }],
  })[0];
}

test("shell policy satisfies a required component rendered through one wrapper hop", () => {
  const root = fixture({
    "app/Route.tsx": `import { Shell } from './Shell';
export default function Route() {
  return <Shell />;
}
`,
    "app/Shell.tsx": `import { ScreenHeader as Header } from '@/ui/atoms';
export function Helper() {
  return <View />;
}
export function Shell({ title }) {
  return <Header />;
}
`,
  });
  const verdict = resolve(root);
  assert.equal(verdict.verdict, "satisfied");
  assert.equal(verdict.component, "ScreenHeader");
  assert.equal(verdict.file, "app/Shell.tsx");
  assert.equal(verdict.line, 6);
});

test("shell policy resolves a locally declared default export and a direct default component import", () => {
  const root = fixture({
    "app/Route.tsx": `import ScreenHeader from '@/ui/atoms/ScreenHeader';
function Route() {
  return <ScreenHeader />;
}
export default Route;
`,
  });
  const verdict = resolve(root);
  assert.equal(verdict.verdict, "satisfied");
  assert.equal(verdict.component, "ScreenHeader");
  assert.equal(verdict.file, "app/Route.tsx");
  assert.equal(verdict.line, 3);
});

test("shell policy follows a wrapper re-exported from a configured barrel", () => {
  const root = fixture({
    "app/Route.tsx": `import { Shell } from '@/ui/molecules';
export default function Route() {
  return <Shell />;
}
`,
    "src/ui/molecules/index.ts": "export { Shell } from './Shell';\n",
    "src/ui/molecules/Shell.tsx": `import { ScreenHeader as Header } from '@/ui/atoms';
export function Shell() {
  return <Header />;
}
`,
  });
  const verdict = resolveShellPolicy({
    root,
    targets: [{ id: "screen", route: "/screen", sourceFiles: ["app/Route.tsx"] }],
    barrels: ["src/ui/atoms/index.ts", "src/ui/molecules/index.ts"],
    shellPolicy: [{
      routeClass: "sub-screen",
      match: ["/**"],
      require: ["ScreenHeader"],
      exceptions: [],
    }],
  })[0];
  assert.equal(verdict.verdict, "satisfied");
  assert.equal(verdict.file, "src/ui/molecules/Shell.tsx");
  assert.equal(verdict.line, 3);
});

for (const [name, wrapper] of [
  ["function declaration", `function Shell() {
  return <Header />;
}`],
  ["const arrow", `const Shell = () => <Header />;`],
  ["const function expression", `const Shell = function Shell() {
  return <Header />;
};`],
]) {
  test(`shell policy resolves a local ${name} wrapper`, () => {
    const root = fixture({
      "app/Route.tsx": `import { ScreenHeader as Header } from '@/ui/atoms';
${wrapper}
export default function Route() {
  return <Shell />;
}
`,
    });
    const verdict = resolve(root);
    assert.equal(verdict.verdict, "satisfied");
    assert.equal(verdict.component, "ScreenHeader");
    assert.equal(verdict.file, "app/Route.tsx");
  });
}

test("shell policy reports an unanalyzable local wrapper as unresolved", () => {
  const root = fixture({
    "app/Route.tsx": `import { ScreenHeader as Header } from '@/ui/atoms';
const Shell = React.memo(() => <Header />);
export default function Route() {
  return <Shell />;
}
`,
  });
  const verdict = resolve(root);
  assert.equal(verdict.verdict, "unresolved");
  assert.deepEqual(verdict.unresolvedComponents, ["Shell"]);
  assert.match(verdict.reason, /could not determine the rendered component boundary/);
});

test("shell policy ignores JSX in unrendered local component and callback bodies", () => {
  const root = fixture({
    "app/Route.tsx": `import { ScreenHeader } from '@/ui/atoms';
export default function Route() {
  const unusedComponent = () => <ScreenHeader />;
  const unusedCallback = () => {
    return <ScreenHeader />;
  };
  return <View renderContent={() => <ScreenHeader />} />;
}
`,
  });
  const verdict = resolve(root);
  assert.equal(verdict.verdict, "violated");
  assert.deepEqual(verdict.missing, ["ScreenHeader", "ScrollViewHeader"]);
  assert.equal(verdict.line, 7);
});

test("shared route roots keep unconditional common chrome for every owning target", () => {
  const root = fixture({
    "app/Route.tsx": `import { ScreenHeader } from '@/ui/atoms';
export default function Route() {
  return <><ScreenHeader /><View /></>;
}
`,
  });
  const verdicts = resolveShellPolicy({
    root,
    targets: [
      { id: "first", route: "/first", sourceFiles: ["app/Route.tsx"] },
      { id: "second", route: "/second", sourceFiles: ["app/Route.tsx"] },
    ],
    barrels: ["src/ui/atoms/index.ts"],
    shellPolicy: [{ routeClass: "sub-screen", match: ["/**"], require: ["ScreenHeader"], exceptions: [] }],
  });
  assert.deepEqual(verdicts.map((verdict) => ({
    targetId: verdict.targetId,
    verdict: verdict.verdict,
    file: verdict.file,
    line: verdict.line,
  })), [
    { targetId: "first", verdict: "satisfied", file: "app/Route.tsx", line: 3 },
    { targetId: "second", verdict: "satisfied", file: "app/Route.tsx", line: 3 },
  ]);
});

test("shared route roots keep branch chrome target-scoped", () => {
  const root = fixture({
    "app/Route.tsx": `import { ScreenHeader } from '@/ui/atoms';
import { Shell } from './Shell';
export default function Route() {
  if (Math.random() > 0.5) return <ScreenHeader />;
  return <Shell />;
}
`,
    "app/Shell.tsx": `import { ScreenHeader } from '@/ui/atoms';
export function Shell() {
  return <ScreenHeader />;
}
`,
  });
  const verdicts = resolveShellPolicy({
    root,
    targets: [
      { id: "header", route: "/header", sourceFiles: ["app/Route.tsx"] },
      { id: "shell", route: "/shell", sourceFiles: ["app/Route.tsx", "app/Shell.tsx"] },
    ],
    allTargets: [
      { id: "header", route: "/header", sourceFiles: ["app/Route.tsx"] },
      { id: "shell", route: "/shell", sourceFiles: ["app/Route.tsx", "app/Shell.tsx"] },
    ],
    barrels: ["src/ui/atoms/index.ts"],
    shellPolicy: [{ routeClass: "sub-screen", match: ["/**"], require: ["ScreenHeader"], exceptions: [] }],
  });
  assert.equal(verdicts[0].verdict, "unresolved");
  assert.match(verdicts[0].reason, /without a target-owned child source/);
  assert.equal(verdicts[1].verdict, "satisfied");
  assert.equal(verdicts[1].file, "app/Shell.tsx");
  assert.equal(verdicts[1].line, 3);
});

test("shell policy reports a required component two wrapper hops below the route as unresolved", () => {
  const root = fixture({
    "app/Route.tsx": `import { First } from './First';
export default function Route() {
  return <First />;
}
`,
    "app/First.tsx": `import { Second } from './Second';
export function First() {
  return <Second />;
}
`,
    "app/Second.tsx": `import { ScreenHeader } from '@/ui/atoms';
export function Second() {
  return <ScreenHeader />;
}
`,
  });
  const verdict = resolve(root);
  assert.equal(verdict.verdict, "unresolved");
  assert.match(verdict.reason, /2 component hops below the route/);
  assert.equal(verdict.file, "app/Route.tsx");
  assert.equal(verdict.line, 3);
});

test("shell policy lets a resolvable sibling satisfy the rule after an unresolved child", () => {
  const root = fixture({
    "app/Route.tsx": `import Opaque from './Opaque';
import Complete from './Complete';
export default function Route() {
  return <><Opaque /><Complete /></>;
}
`,
    "app/Opaque.tsx": "export const notAComponent = true;\n",
    "app/Complete.tsx": `import { ScreenHeader } from '@/ui/atoms';
export default function Complete() {
  return <ScreenHeader />;
}
`,
  });
  const verdict = resolve(root);
  assert.equal(verdict.verdict, "satisfied");
  assert.equal(verdict.component, "ScreenHeader");
  assert.equal(verdict.file, "app/Complete.tsx");
});

test("shell policy lists every unresolved child when no sibling satisfies the rule", () => {
  const root = fixture({
    "app/Route.tsx": `import Missing from './Missing';
import Opaque from './Opaque';
export default function Route() {
  return <><Missing /><Opaque /></>;
}
`,
    "app/Opaque.tsx": "export const notAComponent = true;\n",
  });
  const verdict = resolve(root);
  assert.equal(verdict.verdict, "unresolved");
  assert.deepEqual(verdict.unresolvedComponents, ["Missing", "Opaque"]);
  assert.match(verdict.reason, /Missing, Opaque/);
});

test("shell policy exempts an explicitly listed route before source resolution", () => {
  const root = fixture({});
  const verdict = resolve(root, "/scene", "app/Missing.tsx", ["/scene"]);
  assert.equal(verdict.verdict, "exempt");
  assert.match(verdict.reason, /explicit policy exception/);
});

test("shell policy violation names every allowed component and the root render line", () => {
  const root = fixture({
    "app/Route.tsx": `export default function Route() {
  return (
    <View />
  );
}
`,
  });
  const verdict = resolve(root);
  assert.equal(verdict.verdict, "violated");
  assert.deepEqual(verdict.missing, ["ScreenHeader", "ScrollViewHeader"]);
  assert.equal(verdict.file, "app/Route.tsx");
  assert.equal(verdict.line, 3);
});

test("shell policy ignores required-component lookalikes in comments and strings", () => {
  const root = fixture({
    "app/Route.tsx": `import { ScreenHeader } from '@/ui/atoms';
export default function Route() {
  // <ScreenHeader />
  const debug = "<ScreenHeader />";
  return <View />;
}
`,
  });
  const verdict = resolve(root);
  assert.equal(verdict.verdict, "violated");
  assert.equal(verdict.line, 5);
});

test("route glob query separators are literal URL characters", () => {
  const pattern = globToRegExp("acmemobile://perform?devStage=performing");
  assert.equal(pattern.test("acmemobile://perform?devStage=performing"), true);
  assert.equal(pattern.test("acmemobile://performXdevStage=performing"), false);
});
