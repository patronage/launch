import * as migration_20261029_201036_initial from './20261029_201036_initial';
import * as migration_20261029_230616_sections from './20261029_230616_sections';
import * as migration_20261030_185138_posts_preview from './20261030_185138_posts_preview';
import * as migration_20261030_191931_forms from './20261030_191931_forms';

export const migrations = [
  {
    up: migration_20261029_201036_initial.up,
    down: migration_20261029_201036_initial.down,
    name: '20261029_201036_initial',
  },
  {
    up: migration_20261029_230616_sections.up,
    down: migration_20261029_230616_sections.down,
    name: '20261029_230616_sections',
  },
  {
    up: migration_20261030_185138_posts_preview.up,
    down: migration_20261030_185138_posts_preview.down,
    name: '20261030_185138_posts_preview',
  },
  {
    up: migration_20261030_191931_forms.up,
    down: migration_20261030_191931_forms.down,
    name: '20261030_191931_forms'
  },
];
