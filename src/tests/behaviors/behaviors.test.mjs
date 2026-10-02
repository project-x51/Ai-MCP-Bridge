// node:test driver for the "behaviors" test group (#81): runs tests/behaviors/test_*.mjs one at a time, each as one test.
// Run it alone with `npm run test:group -- behaviors`; `npm test` runs every group in parallel. See tests/helpers/suite.mjs.
import { defineGroup } from '../helpers/suite.mjs'
defineGroup('behaviors')
