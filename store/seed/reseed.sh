#!/bin/zsh
# Reseeds one simulator's Solitaire install for the App Store screenshots and relaunches it.
#   store/seed/reseed.sh <simulator udid> [--style <hex color>]
# Run store/seed/generate.mjs first. See store/README.md.
DIR=${0:A:h}
udid=$1
shift
xcrun simctl terminate $udid com.infinitetoken.solitaire 2> /dev/null
python3 $DIR/write-store.py $udid "$@"
xcrun simctl launch $udid com.infinitetoken.solitaire
