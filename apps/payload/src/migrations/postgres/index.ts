import * as migration_20261029_201516_initial from './20261029_201516_initial';
import * as migration_20261029_230629_sections from './20261029_230629_sections';
import * as migration_20261030_185141_posts_preview from './20261030_185141_posts_preview';
import * as migration_20261030_191933_forms from './20261030_191933_forms';

export const migrations = [
  {
    up: migration_20261029_201516_initial.up,
    down: migration_20261029_201516_initial.down,
    name: '20261029_201516_initial',
  },
  {
    up: migration_20261029_230629_sections.up,
    down: migration_20261029_230629_sections.down,
    name: '20261029_230629_sections',
  },
  {
    up: migration_20261030_185141_posts_preview.up,
    down: migration_20261030_185141_posts_preview.down,
    name: '20261030_185141_posts_preview',
  },
  {
    up: migration_20261030_191933_forms.up,
    down: migration_20261030_191933_forms.down,
    name: '20261030_191933_forms'
  },
];
