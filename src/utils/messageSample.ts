import type { Message } from 'grammy/types';

/** Enough to recognise a pattern, not enough to archive a conversation. */
const TEXT_LIMIT = 500;
const LIST_LIMIT = 20;

function clip(value: string | undefined, limit = TEXT_LIMIT): string | undefined {
  if (!value) return undefined;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * A compact, log-friendly picture of everything a reader of this message sees.
 *
 * Spam that gets past the filter leaves no trace unless someone records what it
 * looked like, and the parts that matter are rarely in the text alone: the
 * payload has turned up in inline-keyboard buttons, in a quote borrowed from
 * another chat, and in a bot mention with a tracking token. This captures all
 * of those in one JSON line, so a sample can be grepped out of the log and
 * turned into a rule.
 */
export function describeMessage(message: Message | undefined): Record<string, unknown> {
  if (!message) return {};

  const text = message.text ?? message.caption;
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  const buttons = (message.reply_markup?.inline_keyboard ?? []).flat().slice(0, LIST_LIMIT);
  const external = message.external_reply;

  let externalTitle: string | undefined;
  if (external?.origin.type === 'channel') externalTitle = external.origin.chat.title;
  else if (external?.chat && 'title' in external.chat) externalTitle = external.chat.title;

  return {
    messageId: message.message_id,
    sender: message.from
      ? {
          id: message.from.id,
          username: message.from.username,
          name: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
          isBot: message.from.is_bot,
        }
      : undefined,
    senderChat: message.sender_chat ? { id: message.sender_chat.id, type: message.sender_chat.type } : undefined,
    text: clip(text),
    entityTypes: entities.length ? [...new Set(entities.map((e) => e.type))] : undefined,
    hiddenLinks: entities
      .filter((e) => e.type === 'text_link')
      .map((e) => (e as { url?: string }).url)
      .filter(Boolean)
      .slice(0, LIST_LIMIT),
    quote: clip(message.quote?.text, 200),
    externalReplyFrom: external
      ? { type: external.origin.type, title: externalTitle, chatId: external.chat?.id }
      : undefined,
    viaBot: message.via_bot?.username,
    forwardFrom: message.forward_origin?.type,
    keyboard: buttons.length
      ? buttons.map((b) => ({ text: clip(b.text, 60), url: 'url' in b ? b.url : undefined }))
      : undefined,
    hasMedia: Boolean(message.photo || message.video || message.document || message.animation || message.sticker),
  };
}
