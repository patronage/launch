<?php

declare(strict_types=1);

// The checks on visitor input to a Formidable form, against WordPress and
// Formidable stubs. They mirror apps/payload/src/lib/form-submission.ts: only
// the form's own fields are kept, every value must fit its field, message
// fields are never stored, and values are cut to the longest kept length.

define('ABSPATH', __DIR__);

/** @var array<string, callable[]> */
$test_filters = [];

function add_filter(string $hook, callable|string $callback, int $priority = 10, int $accepted_args = 1): void {
  global $test_filters;
  $test_filters[$hook][] = $callback;
}
function add_action(string $hook, callable|string $callback, int $priority = 10, int $accepted_args = 1): void {}
function wpautop(string $text): string {
  return "<p>{$text}</p>\n";
}
function is_email(string $value): string|false {
  return filter_var($value, FILTER_VALIDATE_EMAIL) === false ? false : $value;
}
function sanitize_text_field(string $value): string {
  return trim((string) preg_replace('/\s+/', ' ', strip_tags($value)));
}
function sanitize_textarea_field(string $value): string {
  return trim(strip_tags($value));
}
function __return_zero(): int {
  return 0;
}
function is_wp_error(mixed $value): bool {
  return $value instanceof WP_Error;
}

class WP_Error {
  public function __construct(public string $code = '', public string $message = '', public mixed $data = '') {}
  public function get_error_code(): string {
    return $this->code;
  }
  public function get_error_message(): string {
    return $this->message;
  }
  public function get_error_data(): mixed {
    return $this->data;
  }
}

class FrmForm {
  /** @var array<int, object> */
  public static array $forms = [];
  public static function getOne(int $id): ?object {
    return self::$forms[$id] ?? null;
  }
  public static function getAll(array $where = [], string $order = ''): array {
    return array_values(self::$forms);
  }
}

class FrmField {
  /** @var array<int, object[]> */
  public static array $fields = [];
  public static function get_all_for_form(int|string $form_id): array {
    return self::$fields[(int) $form_id] ?? [];
  }
}

class FrmEntry {
  /** @var array<int, array> */
  public static array $created = [];
  public static bool $fails = false;
  public static function create(array $values): int|false {
    if (self::$fails) {
      return false;
    }
    self::$created[] = $values;
    return count(self::$created);
  }
}

require dirname(__DIR__) . '/forms.php';

$failures = 0;
function check(string $label, mixed $actual, mixed $expected): void {
  global $failures;
  if ($actual === $expected) {
    echo "ok    {$label}\n";
    return;
  }
  $failures++;
  echo "FAIL  {$label}\n      expected " . var_export($expected, true) . "\n      actual   " . var_export($actual, true) . "\n";
}

function field(int $id, string $key, string $type, string $name, array $extra = []): object {
  return (object) ($extra + [
    'id' => (string) $id,
    'field_key' => $key,
    'type' => $type,
    'name' => $name,
    'description' => '',
    'required' => '0',
    'default_value' => '',
    'options' => [],
    'field_options' => [],
  ]);
}

$form = (object) [
  'id' => '7',
  'form_key' => 'volunteer',
  'name' => 'Volunteer',
  'status' => 'published',
  'is_template' => '0',
  'options' => ['success_msg' => 'Thanks.', 'submit_value' => ''],
];
FrmForm::$forms = [
  7 => $form,
  8 => (object) ['id' => '8', 'form_key' => 'draft', 'name' => 'Draft', 'status' => 'draft', 'is_template' => '0', 'options' => []],
  9 => (object) ['id' => '9', 'form_key' => 'tpl', 'name' => 'Template', 'status' => 'published', 'is_template' => '1', 'options' => []],
];
FrmField::$fields[7] = [
  field(1, 'volunteer_name', 'text', 'Name', ['required' => '1', 'field_options' => ['classes' => 'frm_half']]),
  field(2, 'volunteer_email', 'email', 'Email', ['required' => '1']),
  field(3, 'guests', 'number', 'Guests'),
  field(4, 'volunteer_topic', 'select', 'Topic', ['options' => [['label' => 'Press', 'value' => 'press'], ['label' => 'Support', 'value' => 'support'], '']]),
  field(5, 'volunteer_terms', 'checkbox', 'I agree to the terms', ['required' => '1', 'options' => ['Agreed']]),
  field(6, 'volunteer_updates', 'checkbox', 'Send me updates'),
  field(7, 'volunteer_note', 'textarea', 'Note'),
  field(8, 'volunteer_intro', 'html', '', ['description' => 'Read this first.']),
  field(9, 'volunteer_upload', 'file', 'Upload'),
];

$valid = ['name' => 'Reader', 'email' => 'reader@example.com', 'terms' => 'true'];
$meta = fn(array $values) => patronage_fields_form_entry_meta($form, $values);
$problem = function (array $values) use ($meta): mixed {
  $result = $meta($values);
  return $result instanceof WP_Error ? [$result->get_error_code(), $result->get_error_message(), $result->get_error_data()] : $result;
};
$invalid = fn(string $message) => ['patronage_form_invalid', $message, ['status' => 400]];

// The form model.
check('an unpublished form is not offered', patronage_fields_formidable_form(8), null);
check('a template form is not offered', patronage_fields_formidable_form(9), null);
check('a missing form is not offered', patronage_fields_formidable_form(404), null);
$model = patronage_fields_form_model(7);
check(
  'the model names fields without their form key prefix, and skips types the UI does not draw',
  array_column($model['fields'], 'name'),
  ['name', 'email', 'guests', 'topic', 'terms', 'updates', 'note', ''],
);
check('a select offers its options without blanks', $model['fields'][3]['options'], [['label' => 'Press', 'value' => 'press'], ['label' => 'Support', 'value' => 'support']]);
check('a layout class becomes a width', $model['fields'][0]['width'], 50);
check('a message field is never required and has no label', [$model['fields'][7]['required'], $model['fields'][7]['label']], [false, null]);
check('an empty submit label falls back to Submit', $model['submitLabel'], 'Submit');

// Valid values.
check(
  "keeps the form's own filled-in fields, trimmed, by Formidable field ID",
  $meta(['name' => '  Reader  ', 'email' => 'reader@example.com', 'guests' => '3', 'topic' => 'press', 'terms' => 'true', 'note' => "Line one\nLine two"]),
  [1 => 'Reader', 2 => 'reader@example.com', 3 => '3', 4 => 'press', 5 => ['Agreed'], 7 => "Line one\nLine two"],
);
check('drops values for fields the form does not have', $meta($valid + ['isAdmin' => 'true', 'role' => 'admin', 'upload' => 'x.php']), $meta($valid));
check('does not read a field by its full Formidable key', $problem(['name' => '', 'volunteer_name' => 'Reader'] + $valid), $invalid('name is required.'));
check('leaves out empty optional fields', $meta($valid + ['guests' => '', 'topic' => '  ', 'note' => '']), $meta($valid));
check('never stores a message field, even when a value is posted under its empty name', $meta($valid + ['' => 'injected']), [1 => 'Reader', 2 => 'reader@example.com', 5 => ['Agreed']]);
check('stores an unticked optional checkbox as nothing', $meta($valid + ['updates' => 'false']), $meta($valid));
check('stores a ticked checkbox without choices as Yes', $meta($valid + ['updates' => 'true'])[6] ?? null, ['Yes']);
check('strips markup from a text value', $meta(['name' => '<b>Reader</b>'] + $valid)[1] ?? null, 'Reader');

$long = $meta($valid + ['note' => str_repeat('x', PATRONAGE_FIELDS_FORM_MAX_VALUE + 10)]);
check('cuts an oversized value to the longest kept length', mb_strlen($long[7] ?? ''), PATRONAGE_FIELDS_FORM_MAX_VALUE);
$multibyte = $meta($valid + ['note' => str_repeat('é', PATRONAGE_FIELDS_FORM_MAX_VALUE + 1)]);
check('counts the longest kept length in characters, not bytes', mb_strlen($multibyte[7] ?? ''), PATRONAGE_FIELDS_FORM_MAX_VALUE);

// Invalid values.
check('refuses a missing required field', $problem(['email' => 'reader@example.com', 'terms' => 'true']), $invalid('name is required.'));
check('refuses a blank required field', $problem(['name' => '   '] + $valid), $invalid('name is required.'));
check('refuses a required field posted as an array', $problem(['name' => ['Reader']] + $valid), $invalid('name is required.'));
check('refuses an unticked required checkbox', $problem(['terms' => 'false'] + $valid), $invalid('terms is required.'));
check('refuses a required checkbox that was not posted', $problem(['name' => 'Reader', 'email' => 'reader@example.com']), $invalid('terms is required.'));
check('refuses an email that is not an address', $problem(['email' => 'reader'] + $valid), $invalid('email must be an email address.'));
check('refuses a number that is not a number', $problem($valid + ['guests' => 'three']), $invalid('guests must be a number.'));
check('refuses a select value not among its options', $problem($valid + ['topic' => 'billing']), $invalid('topic must be one of its options.'));
check('refuses a select value that matches an option label, not its value', $problem($valid + ['topic' => 'Press']), $invalid('topic must be one of its options.'));
check('refuses a checkbox that is not true or false', $problem($valid + ['updates' => 'yes']), $invalid('updates must be true or false.'));
check('refuses a required checkbox posted as its choice instead of true', $problem(['terms' => 'Agreed'] + $valid), $invalid('terms must be true or false.'));

// The value checks on their own.
check('a text field takes any value', patronage_fields_form_value_problem(['type' => 'text'], '<script>'), null);
check('a select without options takes nothing', patronage_fields_form_value_problem(['type' => 'select', 'options' => null], ''), 'must be one of its options');

// Saving.
FrmEntry::$created = [];
check('saves a valid submission', patronage_fields_form_save($form, $valid), true);
check(
  'the saved entry holds the checked values for its form',
  FrmEntry::$created,
  [['form_id' => '7', 'item_key' => '', 'item_meta' => [1 => 'Reader', 2 => 'reader@example.com', 5 => ['Agreed']]]],
);
check("turns off Formidable's duplicate check so a repeat entry is not silently dropped", in_array('__return_zero', $test_filters['frm_time_to_check_duplicates'] ?? [], true), true);

FrmEntry::$created = [];
$refused = patronage_fields_form_save($form, ['email' => 'reader'] + $valid);
check('refuses an invalid submission with its problem', $refused instanceof WP_Error ? $refused->get_error_message() : $refused, 'email must be an email address.');
check('saves nothing for an invalid submission', FrmEntry::$created, []);

FrmEntry::$fails = true;
$failed = patronage_fields_form_save($form, $valid);
check(
  'reports a server error when Formidable does not save the entry',
  $failed instanceof WP_Error ? [$failed->get_error_code(), $failed->get_error_data()] : $failed,
  ['patronage_form_failed', ['status' => 500]],
);
FrmEntry::$fails = false;

if ($failures > 0) {
  echo "\n{$failures} failed\n";
  exit(1);
}
echo "\nall passed\n";
