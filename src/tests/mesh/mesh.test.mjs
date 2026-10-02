// node:test driver for the "mesh" test group (#81): runs tests/mesh/test_*.mjs one at a time, each as one test.
// Run it alone with `npm run test:group -- mesh`; `npm test` runs every group in parallel. See tests/helpers/suite.mjs.
import { defineGroup } from '../helpers/suite.mjs'
defineGroup('mesh')
