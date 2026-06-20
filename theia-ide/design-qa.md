# R-IDE Theia UI QA

Final result: passed

Validated on 2026-06-20 with the browser app at `http://127.0.0.1:3000/`.

Reference:

- `C:\Users\10428\.codex\attachments\6d777821-8442-443f-9261-35b37da4e5fb\image-1.png`

Implementation screenshot:

- `.qa/r-ide-theia-final.png`

Viewport:

- 1519 x 1035

Checks:

- R-IDE brand, compact Chinese menu, command search, run button, and layout controls render in the top bar.
- Theia toolbar is disabled so editor tabs sit directly below the top chrome, matching the browser-like composition.
- Left activity rail and Explorer are visible with `R-PROJECT`; the `Open Editors` section is hidden.
- Center editor opens the Go/YAML demo files with larger code font, minimap, dark theme, and active tab styling.
- Bottom terminal panel is visible and fixed near the reference height.
- Right side uses a custom stacked composition for AI assistant, outline, problems, extensions, and settings.
- Toast notifications are hidden from the first-viewport product presentation.

Notes:

- The top menu keeps the VS Code/Theia `跳转(G)` entry as a useful IDE navigation affordance.
- The demo terminal shows a Windows shell prompt instead of simulated log output; this keeps the prototype runnable on the local Theia base.
