// node:test driver for the WHOLE suite, serially (#81 step 1): every test script in the historical `npm test` order
// (tests/helpers/manifest.mjs ORDER), one at a time, each as one test — `npm run test:serial`. A failing script fails its
// own test and the rest still run. `npm test` runs the same scripts as parallel groups (tests/<group>/<group>.test.mjs).
import { defineAll } from './helpers/suite.mjs'
defineAll()
