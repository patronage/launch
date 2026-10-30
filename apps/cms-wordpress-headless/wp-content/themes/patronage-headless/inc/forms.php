<?php
/**
 * Forms: Formidable Forms holds each form's fields, button label and success
 * message, and stores the entries. A Page Builder "form" section picks one by
 * ID, and this file:
 *
 * - lists Formidable's forms as the section's choices;
 * - exposes the chosen form to WPGraphQL as `form` on the section, shaped
 *   after `Form` in packages/content-model;
 * - takes submissions from the front-end at
 *   POST /wp-json/patronage/v1/forms/<id>/submissions, with { values } as JSON
 *   and the shared secret in X-Headless-Secret-Key, checks each value against
 *   its field and saves a Formidable entry.
 *
 * A field's submitted name is its Formidable field key. Keys are unique
 * across all forms, so a key that starts with its form's key and an
 * underscore (`volunteer_email`) is named without that prefix (`email`).
 */

if (!defined('ABSPATH')) {
  exit();
}

/** Formidable field types the UI draws, by their content-model type. */
const PATRONAGE_HEADLESS_FORM_FIELD_TYPES = [
  'text' => 'text',
  'email' => 'email',
  'textarea' => 'textarea',
  'number' => 'number',
  'select' => 'select',
  'checkbox' => 'checkbox',
  'html' => 'message',
];

/** Formidable's layout classes as a percent of the row. */
const PATRONAGE_HEADLESS_FORM_WIDTHS = [
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
const PATRONAGE_HEADLESS_FORM_MAX_VALUE = 5000;

function patronage_headless_forms_ready(): bool {
  return class_exists('FrmForm') && class_exists('FrmField') && class_exists('FrmEntry');
}

/** A published Formidable form, or null. */
function patronage_headless_formidable_form(int $id): ?object {
  if (!$id || !patronage_headless_forms_ready()) {
    return null;
  }
  $form = FrmForm::getOne($id);
  return is_object($form) && empty($form->is_template) && ($form->status ?? '') === 'published' ? $form : null;
}

/** A field's submitted name: its key, less its form's key prefix. */
function patronage_headless_form_field_name(object $field, object $form): string {
  $prefix = $form->form_key . '_';
  return str_starts_with($field->field_key, $prefix) ? substr($field->field_key, strlen($prefix)) : $field->field_key;
}

/** A choice field's options as {label, value} pairs, without blanks. */
function patronage_headless_form_field_options(object $field): array {
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

function patronage_headless_form_field_width(object $field): ?int {
  $classes = preg_split('/\s+/', (string) ($field->field_options['classes'] ?? '')) ?: [];
  foreach ($classes as $class) {
    if (isset(PATRONAGE_HEADLESS_FORM_WIDTHS[$class])) {
      return PATRONAGE_HEADLESS_FORM_WIDTHS[$class];
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
function patronage_headless_form_fields(object $form): array {
  $fields = [];
  foreach (FrmField::get_all_for_form($form->id) as $field) {
    $type = PATRONAGE_HEADLESS_FORM_FIELD_TYPES[$field->type] ?? null;
    if (!$type) {
      continue;
    }
    $message = $type === 'message' ? trim((string) $field->description) : '';
    $default = is_scalar($field->default_value) ? trim((string) $field->default_value) : '';
    $fields[(int) $field->id] = [
      'type' => $type,
      'name' => $type === 'message' ? '' : patronage_headless_form_field_name($field, $form),
      'label' => $type === 'message' ? null : trim((string) $field->name),
      'required' => $type !== 'message' && !empty($field->required),
      'width' => patronage_headless_form_field_width($field),
      'defaultValue' => $default !== '' ? $default : null,
      'options' => $type === 'select' ? patronage_headless_form_field_options($field) : null,
      'message' => $message !== '' ? wpautop($message) : null,
      // Kept for submissions; not part of the GraphQL type.
      'choices' => patronage_headless_form_field_options($field),
    ];
  }
  return $fields;
}

/** A form as the content model's Form, less the action the front-end sets. */
function patronage_headless_form_model(int $id): ?array {
  $form = patronage_headless_formidable_form($id);
  if (!$form) {
    return null;
  }
  $success = trim((string) ($form->options['success_msg'] ?? ''));
  $submit = trim((string) ($form->options['submit_value'] ?? ''));
  return [
    'id' => (string) $form->id,
    'fields' => array_values(patronage_headless_form_fields($form)),
    'submitLabel' => $submit !== '' ? $submit : 'Submit',
    'confirmation' => $success !== '' ? wpautop($success) : null,
  ];
}

// The section's form choices.
add_filter('acf/load_field/name=form_id', function (array $field): array {
  if (!patronage_headless_forms_ready()) {
    return $field;
  }
  $field['choices'] = [];
  foreach (FrmForm::getAll(['is_template' => 0, 'status' => 'published'], 'name') as $form) {
    $field['choices'][(string) $form->id] = $form->name;
  }
  return $field;
});

add_action('graphql_register_types', function (): void {
  register_graphql_object_type('PatronageFormFieldOption', [
    'description' => 'A choice in a select field.',
    'fields' => [
      'label' => ['type' => ['non_null' => 'String']],
      'value' => ['type' => ['non_null' => 'String']],
    ],
  ]);

  register_graphql_object_type('PatronageFormField', [
    'description' => 'A form field, as FormField in packages/content-model.',
    'fields' => [
      'type' => ['type' => ['non_null' => 'String'], 'description' => 'text, email, textarea, number, select, checkbox or message.'],
      'name' => ['type' => ['non_null' => 'String'], 'description' => 'The submitted value\'s key. Empty for a message.'],
      'label' => ['type' => 'String'],
      'required' => ['type' => ['non_null' => 'Boolean']],
      'width' => ['type' => 'Int', 'description' => 'Percent of the row.'],
      'defaultValue' => ['type' => 'String'],
      'options' => ['type' => ['list_of' => ['non_null' => 'PatronageFormFieldOption']]],
      'message' => ['type' => 'String', 'description' => 'HTML, for a message.'],
    ],
  ]);

  register_graphql_object_type('PatronageForm', [
    'description' => 'A Formidable form, as Form in packages/content-model.',
    'fields' => [
      'id' => ['type' => ['non_null' => 'ID'], 'description' => 'The Formidable form ID.'],
      'fields' => ['type' => ['non_null' => ['list_of' => ['non_null' => 'PatronageFormField']]]],
      'submitLabel' => ['type' => ['non_null' => 'String']],
      'confirmation' => ['type' => 'String', 'description' => 'HTML shown after a successful submission.'],
    ],
  ]);

  register_graphql_field('PageBuilderSectionsFormLayout', 'form', [
    'type' => 'PatronageForm',
    'description' => 'The form the section shows, or null when it is missing or unpublished.',
    'resolve' => function ($layout) {
      $id = is_array($layout) ? ($layout['form_id'] ?? null) : null;
      return patronage_headless_form_model((int) (is_array($id) ? reset($id) : $id));
    },
  ]);
});

/** Why a value does not fit its field, or null when it does. */
function patronage_headless_form_value_problem(array $field, string $value): ?string {
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
function patronage_headless_form_entry_meta(object $form, array $values): array|WP_Error {
  $meta = [];
  foreach (patronage_headless_form_fields($form) as $id => $field) {
    if ($field['type'] === 'message') {
      continue;
    }
    $name = $field['name'];
    $raw = $values[$name] ?? null;
    $value = is_string($raw) ? trim(mb_substr($raw, 0, PATRONAGE_HEADLESS_FORM_MAX_VALUE)) : '';
    // A checkbox posts "false" when unticked; a required one must be ticked.
    $missing = $value === '' || ($field['type'] === 'checkbox' && $value === 'false');

    if ($field['required'] && $missing) {
      return new WP_Error('patronage_form_invalid', "{$name} is required.", ['status' => 400]);
    }
    if ($value === '') {
      continue;
    }
    $problem = patronage_headless_form_value_problem($field, $value);
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

add_action('rest_api_init', function (): void {
  register_rest_route('patronage/v1', '/forms/(?P<id>\d+)/submissions', [
    'methods' => 'POST',
    'permission_callback' => function (WP_REST_Request $request): bool {
      $secret = defined('HEADLESS_SECRET') ? (string) HEADLESS_SECRET : '';
      $sent = (string) $request->get_header('x-headless-secret-key');
      return $secret !== '' && hash_equals($secret, $sent);
    },
    'callback' => function (WP_REST_Request $request) {
      $form = patronage_headless_formidable_form((int) $request['id']);
      if (!$form) {
        return new WP_Error('patronage_form_missing', 'No such form.', ['status' => 404]);
      }
      $values = $request->get_json_params()['values'] ?? null;
      if (!is_array($values)) {
        return new WP_Error('patronage_form_invalid', 'Expected { values }.', ['status' => 400]);
      }
      $meta = patronage_headless_form_entry_meta($form, $values);
      if (is_wp_error($meta)) {
        return $meta;
      }
      // Formidable silently drops an entry that repeats one from the last
      // minute, which would read here as a failure; the form's own sending
      // state already stops double submits.
      add_filter('frm_time_to_check_duplicates', '__return_zero');
      $entry = FrmEntry::create(['form_id' => $form->id, 'item_key' => '', 'item_meta' => $meta]);
      if (!$entry) {
        return new WP_Error('patronage_form_failed', 'The entry was not saved.', ['status' => 500]);
      }
      return new WP_REST_Response(['ok' => true], 201);
    },
  ]);
});
