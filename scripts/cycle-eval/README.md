# Measuring cycle detection

`eval.ts` measures how well the app finds period starts. It uses mcPHASES, a study where 42 people
wore a Fitbit for about three months and took daily hormone tests that mark their cycles.

Run it before and after you change the cycle code (`cycle.ts`, `cycleShapes.ts` or
`sleepHrFloor.ts`), and put both results in your pull request:

```sh
npm run eval:cycles -- path/to/the/mcphases/folder
```

The first run takes a few minutes, because it reads 63 million heart rate readings. It saves what
it needs beside the mcPHASES folder, so later runs take seconds. Add `--rebuild` to read the folder
again, and `--non-rem` to use Google's non-REM heart rate instead of the night's floor.

## Getting the data

mcPHASES is on PhysioNet (doi:10.13026/zx6a-2c81). You need a credentialed PhysioNet account, and
you have to sign its data use agreement. Keep the data out of this repo, never share it, and only
publish totals. The script prints nothing about any one person.

## How it measures

- It runs the app's own code.
- Each person is tested with patterns learned from the other 41 people, never from themselves.
- The app only looks back 240 days, so the test does too.
- A found start counts as right when it's within 3 days of the start the hormone tests mark.
