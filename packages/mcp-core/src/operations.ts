// Shared by every connector's `apply`: how many operations one approval may
// hold, the error a batch that fails validation raises, and the phrase that
// lists changed fields on an approval card.
export const MAX_OPERATIONS = 20;

export class ApplyValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApplyValidationError";
  }
}

export const joinPhrase = (items: string[]): string => {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
};
