# `verify-cli` specification, part 2 of 11: user stories

A repository agent works in a generated repository. A kernel agent maintains
the kernel repository. A carrying agent copies the skill folder into another
product. [Part 10](10-traceability.md#user-stories) maps each story to its
decisions and criteria. The words are the kernel glossary's.

## User Stories

### Arriving and starting

1. As a repository agent, I want the skill to arrive with my Pin, so that its
   helper matches my installed kernel.
2. As a repository agent, I want the full command line shown in the skill
   document, so that I can start the helper with no `bin` entry and no script
   of my own.
3. As a repository agent, I want to name my target by a relative or an
   absolute path, so that I can start a command from any folder.
4. As a repository agent, I want each step started in my repository root, so
   that relative paths in my CLI behave as they do for a user there.

### Trusting a run

5. As a repository agent, I want a run that cannot be trusted to exit 70 with
   a named reason, so that I never act on a verdict from a broken kernel or
   helper.
6. As a repository agent, I want exit 70 kept for the helper and the installed
   kernel, so that a fault in my own CLI is never reported as theirs.
7. As a repository agent, I want an exit 70 to leave standard output empty
   with or without `--json`, so that no reader parses a verdict from an
   untrusted run.
8. As a repository agent, I want a kernel that cannot be imported named as
   that, so that I reinstall instead of reading my own code.
9. As a repository agent, I want a helper that misreports a child's exit code
   or output caught, so that a healthy target is not blamed for the helper's
   fault.

### Checking readiness

10. As a repository agent, I want `ready` to quote my CLI's own start-up
    error, so that I repair my contract before I drive anything.
11. As a repository agent, I want `ready` on a CLI that selects approval
    without state to quote the kernel's sentence, so that I know to add the
    state add-on.
12. As a repository agent, I want `ready` to say when my Bun is not the pinned
    Bun, so that I do not chase a toolchain difference.
13. As a repository agent, I want a passing `ready` to list my own commands
    and the contract version, so that I can see what a sweep will cover.

### Sweeping

14. As a repository agent, I want a sweep derived from my CLI's discovery, so
    that kernel-promised behaviour is checked with nothing written.
15. As a repository agent, I want the sweep to list the owed results, so that
    I know which stations need a scenario.
16. As a repository agent, I want `sweep` to exit 3 when a check fails, so
    that a script can stop on it.
17. As a repository agent, I want `findings` to list every failed check of the
    sweep as data, so that I can read them all, since a refusal carries no
    data.
18. As a repository agent, I want a command with no route word swept
    correctly, so that the unknown-command check is not held against it.
19. As a repository agent, I want stations the kernel adds left out of the
    owed results, so that I owe only what I declared.

### Launching a run

20. As a repository agent, I want `launch` to bind one target to a
    verification run, so that every later command drives the same CLI.
21. As a repository agent, I want `launch` to refuse a folder that holds
    anything, so that two runs never mix their evidence.
22. As a repository agent, I want `launch` to refuse a folder inside a git
    work tree, so that evidence is never committed by accident.
23. As a repository agent, I want `launch` to refuse a target with no Pin
    above it, so that every run row names the kernel commit.
24. As a repository agent, I want the run row to record the pinned commit,
    Bun, the platform, my head commit and my uncommitted path count, so that a
    reader knows what was verified.

### Driving scenarios

25. As a repository agent, I want scenarios with exact expectations, so that
    wrong behaviour is caught.
26. As a repository agent, I want a step with only an exit code refused, so
    that a command that never ran cannot pass.
27. As a repository agent, I want a scenario file that breaks a format rule
    refused by that rule's name before any step runs, so that a typing slip
    cannot drop an expectation.
28. As a repository agent, I want each step bounded in time and output, so
    that a hung or flooding CLI ends as an unmet step.
29. As a repository agent, I want one evidence file for each step with what
    was expected, what was observed and which expectation was unmet, so that I
    can repair without running it again.
30. As a repository agent, I want a `{scratch}` placeholder, so that a
    changing command writes under the scratch folder.
31. As a repository agent, I want to drive a changing command twice, so that
    its second run is shown and not assumed.
32. As a repository agent, I want to drive an interrupted run and the refusal
    that follows it, so that what the state add-on does after a stop is shown.
33. As a repository agent, I want my check command driven as a step, so that
    the same evidence holds it.
34. As a repository agent, I want a scenario that cannot pass reported as
    unmet, so that it is never weakened.
35. As a repository agent, I want a feature driven twice in one verification
    run refused, so that no evidence file is ever overwritten.
36. As a repository agent, I want `drive` to run every step and then exit 3 if
    any was unmet, so that I get every evidence file in one run.

### Reporting

37. As a repository agent, I want one report over both layers, so that each
    station is swept, driven or owed.
38. As a repository agent, I want the report to list unmet steps and
    unconfirmed process ends, so that nothing unfinished hides behind a count.

### Cleaning up and recovering

39. As a repository agent, I want cleanup to remove only the scratch folder,
    so that the evidence folder survives.
40. As a repository agent, I want cleanup to stop nothing by name, so that no
    other process dies.
41. As a repository agent, I want a second cleanup refused under its own
    cause, so that I know nothing is left to remove and nothing else was
    touched.
42. As a repository agent, I want every command on a verification run to check
    each evidence file against its recorded hash, so that a changed or missing
    one exits 70.
43. As a repository agent, I want `pending` to show a helper change that was
    interrupted, so that I know to launch a new verification run.
44. As a repository agent, I want a command on a folder that was never
    launched refused with its repair, so that I do not drive a half-made run.

### Keeping my own map

45. As a repository agent, I want my feature files and scenarios kept in my
    own repository, so that I can edit them, since the installed skill is
    read-only.
46. As a repository agent, I want a seed feature map of five features, so that
    I have a shape to copy.

### Maintaining the skill

47. As a kernel agent, I want each kernel fault class kept as a planted fault,
    so that fault replay keeps the skill honest.
48. As a kernel agent, I want each new refusal and bound to have a planted
    fault, so that removing a guard turns a named test red.
49. As a kernel agent, I want each helper function tested in-process beside
    the process tests, so that coverage sees it.
50. As a kernel agent, I want the helper linted as kernel-consuming code, with
    the kernel-free check as the one named exception, so that it is a true
    first consumer.
51. As a kernel agent, I want commands, add-ons, codes and formats in one
    contract, so that other skills can depend on it.
52. As a kernel agent, I want no code comment to cite a specification
    identifier, so that the code reads without this document.
53. As a kernel agent, I want the skill to work without the programs add-on's
    folder and environment (K7), so that the countersigned capability
    qualification record stays valid.
54. As a carrying agent, I want to know what must be installed beside the
    skill folder, so that a missing kernel is a named failure and not a stack
    trace.

### Deciding

55. As Nathan, I want each settled decision traced to its row, so that I can
    check none was changed.
56. As Nathan, I want every place the inputs and the code disagreed shown
    first, so that I see where the authority was overruled.
57. As Nathan, I want a cold worker's run and one run each on macOS and Linux,
    so that the instructions suffice and no claim is macOS only.
58. As Nathan, I want a report on how the author skill and `cli-design` could
    use the helper, with one idea tried for real, so that I can decide that
    separately.
59. As Nathan, I want every review finding answered in a ledger, so that I can
    see what was fixed and what was declined.

### Added in correction round 1

60. As a repository agent, I want `launch` to refuse a target path that holds
    no file, so that a run is never bound to nothing.
61. As a repository agent, I want `launch` to refuse a `git` failure it cannot
    read, so that a broken `git` is not recorded as no work tree.
62. As a repository agent, I want each target step checked against what the
    kernel promises, unasked, so that an envelope that lies about its exit
    code cannot pass my scenario.
63. As a repository agent, I want a wrongly typed scenario field refused by
    name, so that a string where a list belongs never runs.
64. As a repository agent, I want the check stopped by Ctrl-C to stop the
    helper and my CLI first, so that nothing is left running.
65. As a repository agent, I want a run whose index cannot be read refused by
    name, so that I keep the folder for review and launch another.
66. As a kernel agent, I want the probes compared before `launch` too, so that
    a kernel fault is never recorded as a fault of the repository.
