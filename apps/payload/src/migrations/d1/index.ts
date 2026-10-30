import * as migration_20261029_201036_initial from './20261029_201036_initial';
import * as migration_20261029_230616_sections from './20261029_230616_sections';

export const migrations = [
  {
    up: migration_20261029_201036_initial.up,
    down: migration_20261029_201036_initial.down,
    name: '20261029_201036_initial',
  },
  {
    up: migration_20261029_230616_sections.up,
    down: migration_20261029_230616_sections.down,
    name: '20261029_230616_sections'
  },
];
