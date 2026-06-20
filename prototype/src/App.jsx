import "@vscode/codicons/dist/codicon.css";
import { useMemo, useState } from "react";

const tabs = [
  { id: "workspace", name: "workspace.ts", type: "ts", status: "dirty" },
  { id: "theme", name: "theme.ts", type: "ts" },
  { id: "commands", name: "commands.ts", type: "ts" },
  { id: "package", name: "package.json", type: "json" },
];

const actionButtons = [
  { id: "search", icon: "codicon-search", label: "搜索" },
  { id: "run", icon: "codicon-play", label: "运行" },
  { id: "ai", icon: "codicon-sparkle", label: "AI" },
  { id: "settings", icon: "codicon-settings-gear", label: "设置" },
];

const files = {
  workspace: [
    [
      { t: "import", c: "keyword" },
      { t: " { createWorkspace, defineCommand } ", c: "plain" },
      { t: "from", c: "keyword" },
      { t: " \"@ride/core\";", c: "string" },
    ],
    [
      { t: "import", c: "keyword" },
      { t: " { graphiteTheme } ", c: "plain" },
      { t: "from", c: "keyword" },
      { t: " \"./theme\";", c: "string" },
    ],
    [],
    [
      { t: "const", c: "keyword" },
      { t: " workspace ", c: "variable" },
      { t: "=", c: "operator" },
      { t: " createWorkspace", c: "function" },
      { t: "({", c: "plain" },
    ],
    [
      { t: "  name", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"R-IDE Preview\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  shell", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"top-chrome\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  panels", c: "property" },
      { t: ": { ", c: "plain" },
      { t: "left", c: "property" },
      { t: ": ", c: "plain" },
      { t: "false", c: "constant" },
      { t: ", ", c: "plain" },
      { t: "right", c: "property" },
      { t: ": ", c: "plain" },
      { t: "false", c: "constant" },
      { t: ", ", c: "plain" },
      { t: "bottom", c: "property" },
      { t: ": ", c: "plain" },
      { t: "false", c: "constant" },
      { t: " },", c: "plain" },
    ],
    [
      { t: "  editor", c: "property" },
      { t: ": {", c: "plain" },
    ],
    [
      { t: "    fontSize", c: "property" },
      { t: ": ", c: "plain" },
      { t: "17", c: "number" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "    lineHeight", c: "property" },
      { t: ": ", c: "plain" },
      { t: "1.68", c: "number" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "    theme", c: "property" },
      { t: ": graphiteTheme,", c: "plain" },
    ],
    [
      { t: "  },", c: "plain" },
    ],
    [
      { t: "});", c: "plain" },
    ],
    [],
    [
      { t: "workspace", c: "variable" },
      { t: ".", c: "plain" },
      { t: "register", c: "function" },
      { t: "(", c: "plain" },
      { t: "defineCommand", c: "function" },
      { t: "({", c: "plain" },
    ],
    [
      { t: "  id", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"ride.run.focusedFile\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  title", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"Run current file\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  shortcut", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"Ctrl+Enter\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  run", c: "property" },
      { t: ": ", c: "plain" },
      { t: "async", c: "keyword" },
      { t: " ({ editor, terminal }) ", c: "plain" },
      { t: "=>", c: "operator" },
      { t: " {", c: "plain" },
    ],
    [
      { t: "    const", c: "keyword" },
      { t: " file ", c: "variable" },
      { t: "=", c: "operator" },
      { t: " editor", c: "variable" },
      { t: ".", c: "plain" },
      { t: "activeDocument", c: "property" },
      { t: "();", c: "plain" },
    ],
    [
      { t: "    await", c: "keyword" },
      { t: " terminal", c: "variable" },
      { t: ".", c: "plain" },
      { t: "execute", c: "function" },
      { t: "(`ride run ", c: "string" },
      { t: "${file.path}", c: "interpolation" },
      { t: "`);", c: "string" },
    ],
    [
      { t: "  },", c: "plain" },
    ],
    [
      { t: "}));", c: "plain" },
    ],
    [],
    [
      { t: "export", c: "keyword" },
      { t: " ", c: "plain" },
      { t: "default", c: "keyword" },
      { t: " workspace;", c: "plain" },
    ],
  ],
  theme: [
    [
      { t: "export", c: "keyword" },
      { t: " const", c: "keyword" },
      { t: " graphiteTheme ", c: "variable" },
      { t: "=", c: "operator" },
      { t: " {", c: "plain" },
    ],
    [
      { t: "  surface", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"#101216\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  chrome", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"#171a20\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  activeTab", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"#232833\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  accent", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"#66d9ef\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "} as", c: "plain" },
      { t: " const", c: "keyword" },
      { t: ";", c: "plain" },
    ],
  ],
  commands: [
    [
      { t: "const", c: "keyword" },
      { t: " commands ", c: "variable" },
      { t: "=", c: "operator" },
      { t: " [", c: "plain" },
    ],
    [
      { t: "  ", c: "plain" },
      { t: "\"ride.openProject\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  ", c: "plain" },
      { t: "\"ride.searchEverywhere\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  ", c: "plain" },
      { t: "\"ride.ai.explainSelection\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "];", c: "plain" },
    ],
  ],
  package: [
    [
      { t: "{", c: "plain" },
    ],
    [
      { t: "  \"name\"", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"r-ide\"", c: "string" },
      { t: ",", c: "plain" },
    ],
    [
      { t: "  \"scripts\"", c: "property" },
      { t: ": {", c: "plain" },
    ],
    [
      { t: "    \"dev\"", c: "property" },
      { t: ": ", c: "plain" },
      { t: "\"ride dev --focus\"", c: "string" },
    ],
    [
      { t: "  }", c: "plain" },
    ],
    [
      { t: "}", c: "plain" },
    ],
  ],
};

function Icon({ name }) {
  return <span className={`codicon ${name}`} aria-hidden="true" />;
}

function TopChrome({ activeTab, activeAction, onAction, onTab }) {
  return (
    <header className="top-chrome" aria-label="R-IDE top controls">
      <section className="brand-cluster" aria-label="Workspace">
        <div className="brand-mark">R</div>
        <button className="workspace-switcher" type="button">
          <span>R-IDE</span>
          <strong>stellar-core</strong>
          <Icon name="codicon-chevron-down" />
        </button>
      </section>

      <nav className="browser-tabs" aria-label="Open files">
        {tabs.map((tab) => (
          <button
            className={`file-tab ${activeTab === tab.id ? "is-active" : ""}`}
            key={tab.id}
            onClick={() => onTab(tab.id)}
            type="button"
          >
            <Icon name={tab.type === "json" ? "codicon-json" : "codicon-symbol-file"} />
            <span>{tab.name}</span>
            {tab.status === "dirty" ? <i aria-label="Unsaved changes" /> : null}
          </button>
        ))}
      </nav>

      <div className="command-cluster">
        <button className="command-input" type="button">
          <Icon name="codicon-search" />
          <span>搜索 文件、命令或符号</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div className="action-strip" aria-label="Feature entrances">
          {actionButtons.map((action) => (
            <button
              className={`chrome-action ${activeAction === action.id ? "is-active" : ""}`}
              key={action.id}
              onClick={() => onAction(action.id)}
              title={action.label}
              type="button"
            >
              <Icon name={action.icon} />
              <span>{action.label}</span>
            </button>
          ))}
        </div>

        <div className="diagnostics-pill" aria-label="Workspace status">
          <Icon name="codicon-git-branch" />
          <span>main</span>
          <b>2</b>
        </div>
      </div>
    </header>
  );
}

function CodeLine({ line, index }) {
  return (
    <div className={`code-line ${index === 19 ? "is-cursor-line" : ""}`}>
      <span className="line-number">{String(index + 1).padStart(2, " ")}</span>
      <span className="line-source">
        {line.length === 0 ? "\u00a0" : line.map((token, tokenIndex) => (
          <span className={`syntax-${token.c}`} key={`${index}-${tokenIndex}`}>
            {token.t}
          </span>
        ))}
      </span>
    </div>
  );
}

function EditorCanvas({ activeTab }) {
  const activeFile = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  const source = files[activeTab] ?? files.workspace;
  const filler = useMemo(() => Array.from({ length: Math.max(0, 31 - source.length) }), [source.length]);

  return (
    <main className="editor-canvas" aria-label={`${activeFile.name} editor`}>
      <div className="editor-glow" />
      <div className="editor-scroll-shadow" />
      <section className="code-sheet">
        <div className="editor-inline-meta">
          <span>{activeFile.name}</span>
          <span>UTF-8</span>
          <span>Prettier</span>
        </div>
        <div className="code-block">
          {source.map((line, index) => (
            <CodeLine index={index} key={`line-${index}`} line={line} />
          ))}
          {filler.map((_, index) => (
            <div className="code-line is-empty" key={`empty-${index}`}>
              <span className="line-number">{String(source.length + index + 1).padStart(2, " ")}</span>
              <span className="line-source">&nbsp;</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState("workspace");
  const [activeAction, setActiveAction] = useState("run");

  return (
    <div className="ide-shell">
      <TopChrome
        activeAction={activeAction}
        activeTab={activeTab}
        onAction={setActiveAction}
        onTab={setActiveTab}
      />
      <EditorCanvas activeTab={activeTab} />
    </div>
  );
}
