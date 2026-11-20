#!/bin/sh
bytes=$(/bin/cat | /usr/bin/wc -c | /usr/bin/tr -d " ")
echo "child-stdin-bytes $bytes" >> "$FX_LEDGER"
/usr/bin/yes FX-CHILD-STREAM-MARKER | /usr/bin/head -c 2000000
/usr/bin/yes FX-CHILD-STREAM-MARKER | /usr/bin/head -c 2000000 >&2
