# Desktop shell lab: macOS prototype results

The three simplified desktop hosts completed the same synthetic review path in all 15 measured runs. After the interaction sequence, Tauri's median process-footprint sum was 335.5 MiB and Wails' was 348.4 MiB, compared with Electron's 447.3 MiB. At the end of a 30-second post-render idle window, Electron had the smallest median (239.3 MiB); Tauri and Wails measured 303.1 and 318.1 MiB. This experiment therefore supports a lower footprint for the two WebKit hosts **after these interactions**, not a blanket reduction in every state.

## Method

- Source revision: `781a5d4c6c942871810ce067192546b28639ba04` (based on upstream `df9c7fe`).
- Host: Mac15,6, Apple M3 Pro, 36 GiB memory, macOS 26.6.2, arm64.
- Synthetic medium review: 1 prose block, 2 diagrams, 6 changed files, 3 distinct code references; manifest SHA-256 `e6391b456179aab946d84da47f16e743e3c4241e207bba65baec450527dad11f`. The review content SHA-256 was `c840495096bb3d1d0cee76b0a3a80eb01b5e6cca7ea0cf7f173e6d4e732731d2` in every run.
- Five runs per host, alternating order. Each run used a separate profile. The collector required a rendered review, matching content, the shared UI/CLI operation sequence, a 1440×960 visible foreground window, identified host and helper processes, and no residual process after shutdown.
- `startupMs` runs from starting the shell-lab CLI to its post-render `shell-lab.ready` event. Idle CPU is the difference in cumulative process CPU time over 30 seconds, with one core equal to 100%. Footprint is the sum of macOS `footprint -f bytes` values for identified processes, reported in MiB. It is not RSS or a direct measure of total system RAM.
- The process set includes the shell server Node, Review API Node, native host, Electron renderer/GPU/utility children or WebKit GPU/Networking/WebContent helpers, and any identified short-lived children. For WebKit helpers launched by `launchd`, the collector checks the pre-run PID set, process start time, and matching resource-coalition ID. Missing or ambiguous ownership invalidates the run.

## Results

Median (minimum–maximum), five valid runs per host:

The rounded per-run values are in [observations.csv](observations.csv).

| Host | Idle footprint, MiB | After interaction, MiB | Idle CPU, % of one core | Render ready, s |
| --- | ---: | ---: | ---: | ---: |
| Electron | 239.3 (236.2–241.6) | 447.3 (442.5–453.7) | 1.43 (1.23–1.53) | 1.51 (1.41–1.63) |
| Tauri | 303.1 (199.5–309.4) | 335.5 (333.9–342.1) | 1.70 (1.53–2.03) | 1.11 (1.11–1.21) |
| Wails | 318.1 (313.9–339.5) | 348.4 (326.9–355.8) | 1.80 (1.53–2.10) | 1.32 (1.31–1.52) |

Tauri's post-interaction median is 25.0% below the minimal Electron host; Wails' is 22.1% below it. The idle footprint ranking reverses. Tauri also has a 199.5 MiB idle outlier, so its idle range is much wider than the other two hosts.

## Current Whiteboard app: separate reading

The full Whiteboard release app was built from the same source revision and opened with the same synthetic review in an isolated profile. Its review content SHA-256 matched the prototype runs, the CLI selected that review, and a screenshot of the app's own window showed the review canvas. After a fixed 10-second render wait, the collector verified a visible, foreground, unminimized 1440×960 window through System Events, then sampled the app and its child processes over 30 seconds. The window capture API reported 1200×800 bounds on this macOS display; the two APIs use different coordinate scales. No startup-time comparison was made.

Five valid runs gave an idle process-footprint median of **866.9 MiB** (858.7–901.7) and idle CPU of **23.65% of one core** (22.73–27.66). The rounded values are in [current-app-observations.csv](current-app-observations.csv). One earlier run was excluded because the window was not foreground; an additional run supplied the fifth valid sample. All six runs left zero tracked processes and removed their isolated profiles.

This reading includes the full Code OSS workbench and its services. It has a different UI and a different ready condition from the shell lab. The gap between it and any prototype is **not** an estimate of Electron's contribution.

## Scope

All three hosts share a simplified HTML/JS UI and the existing Review API. They do not reuse Whiteboard's Code OSS canvas, Monaco/editor integration, language services, extensions, embedded terminal, update handling, or the full product UI. Consequently, differences between this lab and the full Whiteboard app include much more than the shell framework. These measurements are from one macOS machine. Windows and Linux CI compiled all three hosts, but GUI behavior and performance were not measured there.

All three native builds passed [Windows and Linux CI](https://github.com/fum1ple/whiteboard/actions/runs/36519871896) at the measured source revision.
