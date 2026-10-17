#!/usr/bin/env python3
"""Writes the screenshot seed (store/seed/seed.json, from generate.mjs) into a simulator's Solitaire
install BEFORE it launches, so it opens on Home with sound off, the guide seen, three weeks of stats and
achievements, and saved games for the gameplay shots. See store/README.md.

  write-store.py <simulator udid> [--style <hex color>]

--style also switches the card faces to Decorated, the back to Ornate and Guest's color to <hex> (the
"Your Cards, Your Colors" shot used #009688, which gives a red felt). The app must not be running.

The store is redux-persist on @react-native-async-storage: on iOS, Library/Application Support/<bundle
id>/RCTAsyncLocalStorage_V1, with values over 1024 characters in a file named by the MD5 of the key.
Slices left out of persist:root keep their initial state.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

BUNDLE = 'com.infinitetoken.solitaire'
HERE = os.path.dirname(os.path.abspath(__file__))

udid = sys.argv[1]
style = sys.argv[sys.argv.index('--style') + 1] if '--style' in sys.argv else None
seed = json.load(open(os.path.join(HERE, 'seed.json')))
container = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', udid, BUNDLE, 'data'], text=True).strip()
store_dir = os.path.join(container, 'Library/Application Support', BUNDLE, 'RCTAsyncLocalStorage_V1')
shutil.rmtree(store_dir, ignore_errors=True)
os.makedirs(store_dir)
manifest = {}


def write(key, value):
    if len(value) > 1024:
        open(os.path.join(store_dir, hashlib.md5(key.encode()).hexdigest()), 'w').write(value)
        manifest[key] = None
    else:
        manifest[key] = value


persisted = json.dumps({'version': -1, 'rehydrated': True})
root = {
    'achievements': json.dumps({'stats': seed['stats'], 'unlocked': seed['unlocked']}),
    'sound': json.dumps({'enabled': False}),
    'guide': json.dumps({'versionSeen': 1}),
}
if style:
    root['settings'] = json.dumps({'cardStyle': 'decorated', 'cardBackStyle': 'ornate'})
    root['tableColor'] = json.dumps({'guestColor': style, 'profileColors': {}})
root['_persist'] = persisted
write('persist:root', json.dumps(root))


# Saved games are Guest's (each game's slot is keyed by owner), at a human pace of about 3 seconds a move.
def save_game(game, board, elapsed, config=None):
    saved = {'state': board['state'], 'undoStack': [], 'moves': board['moves'], 'elapsedSeconds': elapsed}
    if config is not None:
        saved['config'] = config
    write('persist:gameInProgress.' + game, json.dumps({'guest': json.dumps(saved), '_persist': persisted}))


save_game('freecell', seed['finish'], round(seed['finish']['decisions'] * 2.6))
save_game('klondike', seed['boards']['klondike'], seed['boards']['klondike']['moves'] * 3, config=1)
save_game('yukon', seed['boards']['yukon'], seed['boards']['yukon']['moves'] * 3)

json.dump(manifest, open(os.path.join(store_dir, 'manifest.json'), 'w'))
print('seeded', ', '.join(manifest))
