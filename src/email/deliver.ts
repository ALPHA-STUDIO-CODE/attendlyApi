import {
  recordEmailFailure,
  sendEmail,
  type EmailKind,
  type SendEmailResult,
} from "../integrations/resend";
import type { EmailContent } from "./templates";

export interface DeliverParams {
  kind: EmailKind;
  to: string;
  relatedId: string;
  idempotencyKey?: string;
  build: () => EmailContent;
}

export async function deliver(params: DeliverParams): Promise<SendEmailResult> {
  let content: EmailContent;
  try {
    content = params.build();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return recordEmailFailure(
      {
        kind: params.kind,
        to: params.to,
        subject: `(not built) ${params.kind}`,
        relatedId: params.relatedId,
      },
      message.slice(0, 1_000),
    );
  }
  return sendEmail({
    kind: params.kind,
    to: params.to,
    relatedId: params.relatedId,
    idempotencyKey: params.idempotencyKey,
    ...content,
  });
}
