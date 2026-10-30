<?php
/**
 * Forms: Formidable Forms holds each form's fields, button label and success
 * message, and stores the entries. A Page Builder "form" section picks one by
 * ID, and this file:
 *
 * - lists Formidable's forms as the section's choices;
 * - shapes a form after `Form` in packages/content-model
 *   (patronage_fields_form_model);
 * - checks submitted values against the form's fields and turns them into a
 *   Formidable entry's values (patronage_fields_form_entry_meta), and saves
 *   the entry (patronage_fields_form_save).
 *
 * Each install takes submissions its own way: the headless theme over REST
 * for the front-end, the Timber theme from a posted form.
 *
 * A field's submitted name is its Formidable field key. Keys are unique
 * across all forms, so a key that starts with its form's key and an
 * underscore (`volunteer_email`) is named without that prefix (`email`).
 */

if (!defined('ABSPATH')) {
  exit();
}

/** Formidable field types the UI draws, by their content-model type. */
const PATRONAGE_FIELDS_FORM_FIELD_TYPES = [
  'text' => 'text',
  'email' => 'email',
  'textarea' => 'textarea',
  'number' => 'number',
  'select' => 'select',
  'checkbox' => 'checkbox',
  'html' => 'message',
];

/** Formidable's layout classes as a percent of the row. */
const PATRONAGE_FIELDS_FORM_WIDTHS = [
  'frm_full' => 100,
  'frm12' => 100,
  'frm_three_fourths' => 75,
  'frm_two_thirds' => 67,
  'frm_half' => 50,
  'frm_third' => 33,
  'frm_fourth' => 25,
  'frm_sixth' => 17,
];

/** Longest value kept from any one field. */
const PATRONAGE_FIELDS_FORM_MAX_VALUE = 5000;

function patronage_fields_forms_ready(): bool {
  return class_exists('FrmForm') && class_exists('FrmField') && class_exists('FrmEntry');
}

/** A published Formidable form, or null. */
function patronage_fields_formidable_form(int $id): ?object {
  if (!$id || !patronage_fields_forms_ready()) {
    return null;
  }
  $form = FrmForm::getOne($id);
  return is_object($form) && empty($form->is_template) && ($form->status ?? '') === 'published' ? $form : null;
}

/** A field's submitted name: its key, less its form's key prefix. */
function patronage_fields_form_field_name(object $field, object $form): string {
  $prefix = $form->form_key . '_';
  return str_starts_with($field->field_key, $prefix) ? substr($field->field_key, strlen($prefix)) : $field->field_key;
}

/** A choice field's options as {label, value} pairs, without blanks. */
function patronage_fields_form_field_options(object $field): array {
  $options = [];
  foreach ((array) $field->options as $option) {
    $label = is_array($option) ? (string) ($option['label'] ?? '') : (string) $option;
    $value = is_array($option) ? (string) ($option['value'] ?? $label) : (string) $option;
    if ($value !== '') {
      $options[] = ['label' => $label !== '' ? $label : $value, 'value' => $value];
    }
  }
  return $options;
}

function patronage_fields_form_field_width(object $field): ?int {
  $classes = preg_split('/\s+/', (string) ($field->field_options['classes'] ?? '')) ?: [];
  foreach ($classes as $class) {
    if (isset(PATRONAGE_FIELDS_FORM_WIDTHS[$class])) {
      return PATRONAGE_FIELDS_FORM_WIDTHS[$class];
    }
  }
  return null;
}

/**
 * The fields the UI draws, as content-model FormFields keyed by Formidable
 * field ID. A checkbox is one box: its label is the field's name.
 *
 * @return array<int, array>
 */
function patronage_fields_form_fields(object $form): array {
  $fields = [];
  foreach (FrmField::get_all_for_form($form->id) as $field) {
    $type = PATRONAGE_FIELDS_FORM_FIELD_TYPES[$field->type] ?? null;
    if (!$type) {
      continue;
    }
    $message = $type === 'message' ? trim((string) $field->description) : '';
    $default = is_scalar($field->default_value) ? trim((string) $field->default_value) : '';
    $fields[(int) $field->id] = [
      'type' => $type,
      'name' => $type === 'message' ? '' : patronage_fields_form_field_name($field, $form),
      'label' => $type === 'message' ? null : trim((string) $field->name),
      'required' => $type !== 'message' && !empty($field->required),
      'width' => patronage_fields_form_field_width($field),
      'defaultValue' => $default !== '' ? $default : null,
      'options' => $type === 'select' ? patronage_fields_form_field_options($field) : null,
      'message' => $message !== '' ? wpautop($message) : null,
      // Kept for submissions; not part of the GraphQL type.
      'choices' => patronage_fields_form_field_options($field),
    ];
  }
  return $fields;
}

/** A form as the content model's Form, less the action the front-end sets. */
function patronage_fields_form_model(int $id): ?array {
  $form = patronage_fields_formidable_form($id);
  if (!$form) {
    return null;
  }
  $success = trim((string) ($form->options['success_msg'] ?? ''));
  $submit = trim((string) ($form->options['submit_value'] ?? ''));
  return [
    'id' => (string) $form->id,
    'fields' => array_values(patronage_fields_form_fields($form)),
    'submitLabel' => $submit !== '' ? $submit : 'Submit',
    'confirmation' => $success !== '' ? wpautop($success) : null,
  ];
}

// The section's form choices.
add_filter('acf/load_field/name=form_id', function (array $field): array {
  if (!patronage_fields_forms_ready()) {
    return $field;
  }
  $field['choices'] = [];
  foreach (FrmForm::getAll(['is_template' => 0, 'status' => 'published'], 'name') as $form) {
    $field['choices'][(string) $form->id] = $form->name;
  }
  return $field;
});

/** Why a value does not fit its field, or null when it does. */
function patronage_fields_form_value_problem(array $field, string $value): ?string {
  switch ($field['type']) {
    case 'checkbox':
      return in_array($value, ['true', 'false'], true) ? null : 'must be true or false';
    case 'email':
      return is_email($value) ? null : 'must be an email address';
    case 'number':
      return is_numeric($value) ? null : 'must be a number';
    case 'select':
      return in_array($value, array_column($field['options'] ?? [], 'value'), true) ? null : 'must be one of its options';
  }
  return null;
}

/**
 * The entry's values by Formidable field ID, or a WP_Error naming the first
 * problem. Only the form's own fields are kept; empty optional fields are
 * left out. A ticked checkbox saves its one choice, as Formidable does.
 */
function patronage_fields_form_entry_meta(object $form, array $values): array|WP_Error {
  $meta = [];
  foreach (patronage_fields_form_fields($form) as $id => $field) {
    if ($field['type'] === 'message') {
      continue;
    }
    $name = $field['name'];
    $raw = $values[$name] ?? null;
    $value = is_string($raw) ? trim(mb_substr($raw, 0, PATRONAGE_FIELDS_FORM_MAX_VALUE)) : '';
    // A checkbox posts "false" when unticked; a required one must be ticked.
    $missing = $value === '' || ($field['type'] === 'checkbox' && $value === 'false');

    if ($field['required'] && $missing) {
      return new WP_Error('patronage_form_invalid', "{$name} is required.", ['status' => 400]);
    }
    if ($value === '') {
      continue;
    }
    $problem = patronage_fields_form_value_problem($field, $value);
    if ($problem) {
      return new WP_Error('patronage_form_invalid', "{$name} {$problem}.", ['status' => 400]);
    }
    if ($field['type'] === 'checkbox') {
      if ($value === 'true') {
        $meta[$id] = [$field['choices'][0]['value'] ?? 'Yes'];
      }
      continue;
    }
    $meta[$id] = $field['type'] === 'textarea' ? sanitize_textarea_field($value) : sanitize_text_field($value);
  }
  return $meta;
}

/**
 * Saves checked values as a Formidable entry. Returns true, or a WP_Error
 * naming the first problem with the values.
 */
function patronage_fields_form_save(object $form, array $values): true|WP_Error {
  $meta = patronage_fields_form_entry_meta($form, $values);
  if (is_wp_error($meta)) {
    return $meta;
  }
  // Formidable silently drops an entry that repeats one from the last
  // minute, which would read as a failure; each front-end's sending state
  // already stops double submits.
  add_filter('frm_time_to_check_duplicates', '__return_zero');
  $entry = FrmEntry::create(['form_id' => $form->id, 'item_key' => '', 'item_meta' => $meta]);
  return $entry ? true : new WP_Error('patronage_form_failed', 'The entry was not saved.', ['status' => 500]);
}
