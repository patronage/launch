import * as migration_20261029_201516_initial from "./20261029_201516_initial";

export const migrations = [
  {
    down: migration_20261029_201516_initial.down,
    name: "20261029_201516_initial",
    up: migration_20261029_201516_initial.up,
  },
];
