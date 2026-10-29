import * as migration_20261029_201516_initial from './20261029_201516_initial';
import * as migration_20261029_230629_sections from './20261029_230629_sections';

export const migrations = [
  {
    up: migration_20261029_201516_initial.up,
    down: migration_20261029_201516_initial.down,
    name: '20261029_201516_initial',
  },
  {
    up: migration_20261029_230629_sections.up,
    down: migration_20261029_230629_sections.down,
    name: '20261029_230629_sections'
  },
];
