import * as migration_20261029_201036_initial from "./20261029_201036_initial";

export const migrations = [
  {
    down: migration_20261029_201036_initial.down,
    name: "20261029_201036_initial",
    up: migration_20261029_201036_initial.up,
  },
];
