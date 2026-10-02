// node:test driver for the "doorbell" test group (#81): runs tests/doorbell/test_*.mjs one at a time, each as one test.
// Run it alone with `npm run test:group -- doorbell`; `npm test` runs every group in parallel. See tests/helpers/suite.mjs.
import { defineGroup } from '../helpers/suite.mjs'
defineGroup('doorbell')
