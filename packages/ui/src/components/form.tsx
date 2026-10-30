"use client";

import type { Form as FormModel, FormField } from "@launch/content-model";
import type { FormEvent, ReactNode } from "react";
import { useId, useState } from "react";

import { cn } from "../utils";
import { Button } from "./button";

type Status = "idle" | "sending" | "sent" | "failed";

const controlClass =
  "border-input bg-background text-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-base outline-none focus-visible:ring-2";

/** The submitted values: each named field's text, or "true"/"false" for checkboxes. */
const readValues = (form: HTMLFormElement, fields: FormField<ReactNode>[]) => {
  const data = new FormData(form);

  return Object.fromEntries(
    fields.flatMap((field) => {
      if (field.type === "message") {
        return [];
      }

      const value =
        field.type === "checkbox"
          ? String(data.has(field.name))
          : String(data.get(field.name) ?? "");

      return [[field.name, value]];
    })
  );
};

const Control = ({
  field,
  id,
}: {
  field: FormField<ReactNode>;
  id: string;
}) => {
  const common = {
    id,
    name: field.name,
    required: field.required,
  };

  switch (field.type) {
    case "textarea": {
      return (
        <textarea
          className={cn(controlClass, "min-h-32")}
          defaultValue={field.defaultValue}
          {...common}
        />
      );
    }

    case "select": {
      return (
        <select
          className={controlClass}
          defaultValue={field.defaultValue ?? ""}
          {...common}
        >
          <option disabled value="">
            Choose…
          </option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }

    case "checkbox": {
      return (
        <input
          className="accent-primary size-4"
          defaultChecked={field.defaultValue === "true"}
          type="checkbox"
          {...common}
        />
      );
    }

    default: {
      return (
        <input
          className={controlClass}
          defaultValue={field.defaultValue}
          type={field.type}
          {...common}
        />
      );
    }
  }
};

const Field = ({ field }: { field: FormField<ReactNode> }) => {
  const id = useId();

  const style = field.width
    ? { flexBasis: `calc(${field.width}% - 1rem)` }
    : {};

  if (field.type === "message") {
    return (
      <div className="prose basis-full" style={style}>
        {field.message}
      </div>
    );
  }

  const label = (
    <label className="text-sm font-medium" htmlFor={id}>
      {field.label ?? field.name}
      {field.required ? <span aria-hidden="true"> *</span> : null}
    </label>
  );

  return (
    <div
      className={cn(
        "flex min-w-48 grow basis-full",
        field.type === "checkbox"
          ? "flex-row-reverse items-center justify-end gap-3"
          : "flex-col gap-2"
      )}
      style={style}
    >
      {label}
      <Control field={field} id={id} />
    </div>
  );
};

/**
 * A CMS-defined form. Posts `{ formId, values }` as JSON to the form's action
 * and shows its confirmation once the app accepts the submission.
 */
export const Form = ({ form }: { form: FormModel<ReactNode> }) => {
  const [status, setStatus] = useState<Status>("idle");

  if (status === "sent") {
    return (
      <output className="prose block">
        {form.confirmation ?? <p>Thanks, we got it.</p>}
      </output>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("sending");

    try {
      const response = await fetch(form.action, {
        body: JSON.stringify({
          formId: form.id,
          values: readValues(event.currentTarget, form.fields),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      setStatus(response.ok ? "sent" : "failed");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <form className="flex flex-wrap gap-x-4 gap-y-5" onSubmit={submit}>
      {form.fields.map((field, index) => (
        <Field field={field} key={field.name || `message-${index}`} />
      ))}
      <div className="flex basis-full flex-col items-start gap-3">
        <Button disabled={status === "sending"} type="submit">
          {status === "sending" ? "Sending…" : form.submitLabel}
        </Button>
        {status === "failed" ? (
          <p className="text-destructive text-sm" role="alert">
            Something went wrong. Please try again.
          </p>
        ) : null}
      </div>
    </form>
  );
};
