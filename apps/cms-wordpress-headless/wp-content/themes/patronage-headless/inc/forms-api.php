<?php
/**
 * Forms for the front-end: exposes a form section's Formidable form to
 * WPGraphQL as `form`, and takes submissions at
 * POST /wp-json/patronage/v1/forms/<id>/submissions, with { values } as JSON
 * and the shared secret in X-Headless-Secret-Key. The form model, the checks
 * and the entry come from wordpress-shared/patronage-fields/forms.php.
 */

if (!defined('ABSPATH')) {
  exit();
}

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
      return patronage_fields_form_model((int) (is_array($id) ? reset($id) : $id));
    },
  ]);
});

add_action('rest_api_init', function (): void {
  register_rest_route('patronage/v1', '/forms/(?P<id>\d+)/submissions', [
    'methods' => 'POST',
    'permission_callback' => function (WP_REST_Request $request): bool {
      $secret = defined('HEADLESS_SECRET') ? (string) HEADLESS_SECRET : '';
      $sent = (string) $request->get_header('x-headless-secret-key');
      return $secret !== '' && hash_equals($secret, $sent);
    },
    'callback' => function (WP_REST_Request $request) {
      $form = patronage_fields_formidable_form((int) $request['id']);
      if (!$form) {
        return new WP_Error('patronage_form_missing', 'No such form.', ['status' => 404]);
      }
      $values = $request->get_json_params()['values'] ?? null;
      if (!is_array($values)) {
        return new WP_Error('patronage_form_invalid', 'Expected { values }.', ['status' => 400]);
      }
      $saved = patronage_fields_form_save($form, $values);
      if (is_wp_error($saved)) {
        return $saved;
      }
      return new WP_REST_Response(['ok' => true], 201);
    },
  ]);
});
