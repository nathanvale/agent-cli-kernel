# Doctor

`bun run doctor` tells a template contributor whether this checkout can run
its gates: the pinned Bun, an installed toolchain, Fallow's readiness and the
host load. Every failing line names its repair, and the run ends with how to
know the repair is done. `bun run test` and `check:commits` run it first.

## Sub-features

- `doctor-green` prints `ok` for bun, toolchain and fallow, and exits 0.
- `doctor-bun` refuses a Bun other than the pin, naming `mise exec`.
- `doctor-toolchain` refuses a checkout with no `node_modules`.
- `doctor-load` warns, without failing, when load exceeds the core count.
- `doctor-gating` stops `check:commits` when the doctor fails.

## How to get to it (user POV)

- Run `bun run doctor` in the template checkout, as `AGENTS.md` says before
  work.
- `bun run test` runs it as `pretest`; `bun run check:commits` runs it first.

## Driving it with session.sh

Preconditions:

- A launched run; `doctor` passes.

- **Green.** Record `doctor-green` in `template`: `bun run --silent doctor`.
  Exit 0; stdout lines `ok bun: Bun 1.4.4 matches the toolchain pin.`,
  `ok toolchain: node_modules resolves the accepted lint, compiler and semantic backends.`,
  `ok fallow: fallow doctor passes.` and an `ok load` or `WARN load` line.
- **Red, Bun.** Record `doctor-red-bun` in `template`:
  `mise exec bun@1.4.0 -- bun run --silent doctor`. Exit 1; stdout holds
  `FAIL bun: found Bun 1.4.0, pinned 1.4.4. Repair: run each command as mise exec bun@1.4.4 -- <command>.`
  and ends `Done when bun run doctor passes.`
- **Red, toolchain.** Record `doctor-red-toolchain` in `template`:
  `mv node_modules ../node_modules.aside && bun run --silent doctor; status=$?; mv ../node_modules.aside node_modules; exit $status`.
  Exit 1; stdout holds
  `FAIL toolchain: node_modules is missing. Repair: bun install --frozen-lockfile.`
  and no `fallow` line. Rerun `doctor-green` afterwards: it passes.
- **Gating.** Record `doctor-red-gating` in `template`:
  `mv node_modules ../node_modules.aside && bun run --silent check:commits HEAD~1; status=$?; mv ../node_modules.aside node_modules; exit $status`.
  Exit 1; stdout ends `Refused: repair the doctor's FAIL lines, then rerun.`
- **Planted fault.** Record `doctor-fault` in `template`:
  `bun run --silent fault-replay c6d3f09-doctor`. Exit 0 and
  `KILLED c6d3f09-doctor`: a failing `fallow doctor` check fails the doctor.

## Gotchas

- `bun run doctor --help` ignores the flag and runs the doctor.
- `WARN load` is common on a busy Mac and is not a failure. It warns that the
  full suite's timing-sensitive tests may flake.
- `mise exec bun@1.4.0` needs mise and that Bun installed. Where neither
  exists, the toolchain red is the hands-on red, and the fault replay covers
  the Fallow branch.
