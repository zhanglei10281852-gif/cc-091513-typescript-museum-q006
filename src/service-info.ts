export const serviceName = "科学展签更正发布台";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}
