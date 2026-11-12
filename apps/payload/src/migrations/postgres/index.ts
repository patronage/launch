import * as migration_20261029_201516_initial from './20261029_201516_initial';
import * as migration_20261029_230629_sections from './20261029_230629_sections';
import * as migration_20261030_185141_posts_preview from './20261030_185141_posts_preview';
import * as migration_20261030_191933_forms from './20261030_191933_forms';
import * as migration_20261030_201527_heroes from './20261030_201527_heroes';
import * as migration_20261110_222857_seo_redirects from './20261110_222857_seo_redirects';

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
    name: '20261030_191933_forms',
  },
  {
    up: migration_20261030_201527_heroes.up,
    down: migration_20261030_201527_heroes.down,
    name: '20261030_201527_heroes',
  },
  {
    up: migration_20261110_222857_seo_redirects.up,
    down: migration_20261110_222857_seo_redirects.down,
    name: '20261110_222857_seo_redirects'
  },
];
