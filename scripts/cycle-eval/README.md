# Cycle finder evaluation

This measures how well the cycle finder (`src/pipeline/cycle.ts`) finds period starts. It runs the
finder on mcPHASES, a dataset of people whose cycles were marked by daily hormone tests. Run it
before and after any change to the finder, its shapes (`cycleShapes.ts`) or the sleeping heart
rate it reads (`sleepHrFloor.ts`), and put both sets of totals in the pull request.

```sh
npm run eval:cycles -- ~/data/mcphases/mcphases-a-dataset-of-physiological-hormonal-and-self-reported-events-and-symptoms-for-menstrual-health-tracking-with-wearables-1.0.0
```

You can set `MCPHASES_DIR` instead of passing the folder.

- **The first run takes a few minutes.** It reads the minute heart rate, 63 million rows, and
  keeps the nights it builds in a file beside the dataset folder. Later runs read that file and
  take seconds.
- **`--rebuild`** reads the dataset again. Use it after changing `mcphases.ts`.
- **`--print-shapes`** also prints the shapes rebuilt from everyone, in the form
  `cycleShapes.ts` holds them.

## Getting mcPHASES

mcPHASES is restricted data on PhysioNet (doi:10.13026/zx6a-2c81). Downloading it needs a
credentialed PhysioNet account, and you sign its data use agreement. Under that agreement:

- **The data never goes in this repo.** That includes the cached nights and anything read from
  them person by person. The script prints totals only. Keep it that way.
- **Never share the data,** and never try to identify anyone in it.

## What it prints

Every number comes from the app's own code, run the way the app runs it:

- **Each person is scored with shapes made without their own nights.** No one is judged by a
  shape their own nights helped make.
- **Each study stretch is read on its last day,** with the nights the app would have then.
- **A found start counts as right when it's within 3 days** of the first day the hormone tests
  mark menstrual.

The sections it prints:

- **Accuracy:** how often cycles show, how many period starts are found and how many of the shown
  starts are real. It also measures the second half of each cycle, with nothing logged, with the
  first period logged, and with every period logged.
- **Both sleeping heart rates:** the night's floor, and Google's non-REM heart rate, which the
  finder reads until the floor covers the nights.
- **How soon a start shows,** reading each stretch morning by morning, and whether a shown start
  moves later.
- **False cycles,** in two ways:
  - people simulated without cycles, the test the bar was set on (at most 1 in 20 may see one);
  - the real nights shuffled a week at a time, which keeps their noise and breaks their rhythm.
- **The shapes rebuilt from all 42 people,** against the ones the app ships. This checks that the
  nights are read the way the shipped shapes were made.

`docs/ARCHITECTURE.md` (Cycles, How accurate) quotes these numbers. Update it when they change.
