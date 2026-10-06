import { serverStore } from '../stores/serverStore';
import { channelSettingsModal } from './ChannelSettingsModal';

export class EditChannelModal {
  open(channelId: string): void {
    const channel = serverStore.getChannel(channelId);
    if (channel) channelSettingsModal.open({ kind: 'channel', value: channel });
  }

  close(): void { channelSettingsModal.close(); }
}

export const editChannelModal = new EditChannelModal();
