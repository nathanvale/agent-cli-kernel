# Kernel Trial

The `kernel-trial` check runs the template's kernel trial on a pull
request's head commit, with the template checked out beside this repository.
It is advice only: it is not a required check, so a red one does not block
merging. A red one says the trial did not pass for that commit. Read its log
to tell a checkout, an install or a time limit from a kernel change the
template cannot take. To run it here, put a template checkout beside this
repository and run `bun run kernel-trial <full commit> --kernel <this
repository>` in it.
