'use strict';

const { getNextTagVersion } = require('../src/lib/tarkov-api-shared.cjs');

process.stdout.write(`${getNextTagVersion()}\n`);
