import type {
  BotCarouselPresentation,
  BotForm,
  BotMessageContent,
  BotPublishedMessageContent,
  LiveActionCreate,
} from '../src';

const presentation = {
  format: 'portrait',
  fit: 'contain',
  size: 'compact',
} satisfies BotCarouselPresentation;

const form = {
  title: 'Images',
  fields: [{ name: 'images', label: 'Images', type: 'image-list', maxItems: 5, presentation }],
} satisfies BotForm;

const reply = {
  content: 'Preview',
  components: [{
    type: 'carousel',
    imageAssetRefs: ['f2b47144-577a-4ea0-8d09-93e0d39a6b6e'],
    presentation,
  }],
} satisfies BotMessageContent;

const action = {
  channelId: 'channel',
  invocationId: 'invocation',
  title: 'Images',
  description: '',
  expiresAt: Date.now() + 60_000,
  imageAssetRefs: reply.components[0].imageAssetRefs,
  imagePresentation: presentation,
  content: { kind: 'form', form },
} satisfies LiveActionCreate;

const published: BotPublishedMessageContent = { content: 'Text only' };
void action;
void published;

// @ts-expect-error Persistent publications cannot retain temporary image assets.
const invalidPublished: BotPublishedMessageContent = reply;
void invalidPublished;
