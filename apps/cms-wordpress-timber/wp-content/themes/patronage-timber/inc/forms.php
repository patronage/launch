<?php
/**
 * The Page Builder form section: a Formidable form, drawn by the theme like
 * @launch/ui's Form and posted back to the page it is on, without JavaScript.
 *
 * The form model and the checks on submitted values are shared with the
 * headless install (wordpress-shared/patronage-fields/forms.php). A valid
 * submission saves a Formidable entry and redirects back to the page with
 * ?form-sent=<id>, which shows the form's confirmation; an invalid one
 * renders the page again with the problem and the visitor's values.
 */

if (!defined('ABSPATH')) {
  exit();
}

/** Hidden field naming the submitted form. */
const PATRONAGE_TIMBER_FORM_ID_FIELD = 'patronage_form_id';

/** A field people leave empty and form-filling bots tend not to. */
const PATRONAGE_TIMBER_FORM_HONEYPOT = 'patronage_form_website';

/**
 * The last submission on this request, when it failed:
 * {id, error, values}. Views show the error and keep the values.
 */
function patronage_timber_form_result(?array $set = null): ?array {
  static $result = null;
  if ($set !== null) {
    $result = $set;
  }
  return $result;
}

/** The posted values for a form's fields, as the shared checks expect them. */
function patronage_timber_form_values(array $model): array {
  $posted = wp_unslash($_POST['fields'] ?? []);
  $posted = is_array($posted) ? $posted : [];
  $values = [];
  foreach ($model['fields'] as $field) {
    if ($field['type'] === 'message') {
      continue;
    }
    $name = $field['name'];
    // An unticked checkbox posts nothing; the shared checks expect "false".
    $values[$name] =
      $field['type'] === 'checkbox'
        ? (isset($posted[$name]) ? 'true' : 'false')
        : (is_string($posted[$name] ?? null) ? $posted[$name] : '');
  }
  return $values;
}

add_action('template_redirect', function (): void {
  if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || !isset($_POST[PATRONAGE_TIMBER_FORM_ID_FIELD]) || !is_singular()) {
    return;
  }
  $id = (int) $_POST[PATRONAGE_TIMBER_FORM_ID_FIELD];
  $form = function_exists('patronage_fields_formidable_form') ? patronage_fields_formidable_form($id) : null;
  $model = $form ? patronage_fields_form_model($id) : null;
  if (!$form || !$model) {
    return;
  }
  $back = add_query_arg('form-sent', $id, get_permalink()) . '#form-' . $id;

  // Treat a filled honeypot as sent, so a bot learns nothing.
  if (trim((string) ($_POST[PATRONAGE_TIMBER_FORM_HONEYPOT] ?? '')) !== '') {
    wp_safe_redirect($back, 303);
    exit();
  }

  $values = patronage_timber_form_values($model);
  $saved = patronage_fields_form_save($form, $values);
  if (is_wp_error($saved)) {
    status_header((int) ($saved->get_error_data()['status'] ?? 400));
    patronage_timber_form_result(['id' => (string) $id, 'error' => $saved->get_error_message(), 'values' => $values]);
    return;
  }
  wp_safe_redirect($back, 303);
  exit();
});

/**
 * A Page Builder form row as a content-model FormBlock, with what the view
 * needs on top: where to post, whether this visit follows a sent submission,
 * and a failed submission's error and values. Null when the form is missing
 * or unpublished.
 */
function patronage_timber_form_block(array $row): ?array {
  if (!function_exists('patronage_fields_form_model')) {
    return null;
  }
  $id = $row['form_id'] ?? null;
  $model = patronage_fields_form_model((int) (is_array($id) ? reset($id) : $id));
  if (!$model) {
    return null;
  }
  $result = patronage_timber_form_result();
  $failed = $result && $result['id'] === $model['id'];

  return [
    'type' => 'form',
    'heading' => patronage_timber_text($row['heading'] ?? null),
    'body' => patronage_timber_rich($row['body'] ?? null),
    'form' => array_filter($model, fn($value) => $value !== null) + [
      'action' => get_permalink() . '#form-' . $model['id'],
      'sent' => !$failed && ($_GET['form-sent'] ?? '') === $model['id'],
      'error' => $failed ? $result['error'] : null,
      'values' => $failed ? $result['values'] : [],
      'idField' => PATRONAGE_TIMBER_FORM_ID_FIELD,
      'honeypot' => PATRONAGE_TIMBER_FORM_HONEYPOT,
    ],
  ];
}
