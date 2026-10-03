export type FriendPresence = 'online' | 'offline';

export interface FriendHomeEntry {
  id: string;
  nickname: string;
  avatarUrl?: string;
  presence: FriendPresence;
}

export interface PendingFriendEntry {
  id: string;
  nickname: string;
  avatarUrl?: string;
  direction: 'incoming' | 'outgoing';
}

export interface BlockedFriendEntry {
  id: string;
  nickname: string;
  avatarUrl?: string;
}

export interface FriendsHomeSnapshot {
  friends: FriendHomeEntry[];
  pending: PendingFriendEntry[];
  blocked: BlockedFriendEntry[];
}

export type FriendsHomeListener = (snapshot: FriendsHomeSnapshot) => void;

export class FriendsHomeModel {
  private snapshot: FriendsHomeSnapshot = { friends: [], pending: [], blocked: [] };
  private readonly listeners = new Set<FriendsHomeListener>();

  public getSnapshot(): FriendsHomeSnapshot {
    return {
      friends: [...this.snapshot.friends],
      pending: [...this.snapshot.pending],
      blocked: [...this.snapshot.blocked],
    };
  }

  public setSnapshot(snapshot: FriendsHomeSnapshot): void {
    this.snapshot = {
      friends: [...snapshot.friends],
      pending: [...snapshot.pending],
      blocked: [...snapshot.blocked],
    };
    this.emit();
  }

  public subscribe(listener: FriendsHomeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export const friendsHomeModel = new FriendsHomeModel();
