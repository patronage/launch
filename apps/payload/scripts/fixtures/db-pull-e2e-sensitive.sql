-- Rows that must never leave PlanetScale, added to the demo seed by
-- db-pull-e2e.test.mjs. Every value is marked MUSTNOTLEAVE; the test fails if
-- the marker shows up in a dump or in the local copy.
insert into users (email, salt, hash, reset_password_token, login_attempts, updated_at, created_at)
values
  ('mustnotleave-editor@example.com', 'MUSTNOTLEAVE-salt', 'MUSTNOTLEAVE-hash', 'MUSTNOTLEAVE-reset', 0, now(), now()),
  ('mustnotleave-admin@example.com', 'MUSTNOTLEAVE-salt-2', 'MUSTNOTLEAVE-hash-2', null, 0, now(), now());

insert into users_sessions (_order, _parent_id, id, created_at, expires_at)
select 1, id, 'MUSTNOTLEAVE-session', now(), now() + interval '1 day' from users
where email = 'mustnotleave-editor@example.com';

insert into form_submissions (form_id, updated_at, created_at)
select id, now(), now() from forms order by id limit 1;

insert into form_submissions_submission_data (_order, _parent_id, id, field, value)
select 1, id, 'MUSTNOTLEAVE-answer-id', 'email', 'MUSTNOTLEAVE-visitor@example.com'
from form_submissions order by id desc limit 1;

insert into forms_emails (_order, _parent_id, id, email_to, subject)
select 1, id, 'MUSTNOTLEAVE-email-id', 'MUSTNOTLEAVE-staff@example.com', 'MUSTNOTLEAVE subject'
from forms order by id limit 1;

insert into payload_preferences (key, value, updated_at, created_at)
values ('MUSTNOTLEAVE-preference', '{"note": "MUSTNOTLEAVE"}', now(), now());

insert into payload_preferences_rels ("order", parent_id, path, users_id)
select 1, p.id, 'user', u.id from payload_preferences p, users u
where p.key = 'MUSTNOTLEAVE-preference' and u.email = 'mustnotleave-editor@example.com';

insert into payload_kv (key, data) values ('MUSTNOTLEAVE-key', '{"note": "MUSTNOTLEAVE"}');

-- A link from content to a user: the copy keeps the page and drops the link.
insert into pages_rels ("order", parent_id, path, users_id)
select 1, (select min(id) from pages), 'createdBy', id from users
where email = 'mustnotleave-editor@example.com';
