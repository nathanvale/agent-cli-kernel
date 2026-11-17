#!/bin/sh
# Test-only stream probe: records how many stdin bytes it could read, then
# floods stdout and stderr with a marker. Owned by the T2 programs tests.
bytes=$(/bin/cat | /usr/bin/wc -c | /usr/bin/tr -d " ")
echo "child-stdin-bytes $bytes" >> "$FX_LEDGER"
/usr/bin/yes FX-CHILD-STREAM-MARKER | /usr/bin/head -c 2000000
/usr/bin/yes FX-CHILD-STREAM-MARKER | /usr/bin/head -c 2000000 >&2
