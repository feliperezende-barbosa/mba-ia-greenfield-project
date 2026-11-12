import type { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import type { CreateDraftInput } from '../videos/videos.repository';

let sequence = 0;

export async function createTestChannel(
  dataSource: DataSource,
): Promise<Channel> {
  const suffix = `${Date.now()}_${++sequence}`;
  const user = await dataSource.getRepository(User).save(
    dataSource.getRepository(User).create({
      email: `video_owner_${suffix}@example.com`,
      password: 'hashed',
    }),
  );
  return dataSource.getRepository(Channel).save(
    dataSource.getRepository(Channel).create({
      name: `Channel ${suffix}`,
      nickname: `chan_${suffix}`,
      user_id: user.id,
    }),
  );
}

export function buildDraftInput(
  channelId: string,
  overrides: Partial<CreateDraftInput> = {},
): CreateDraftInput {
  return {
    channel_id: channelId,
    title: 'My holiday video',
    original_filename: 'holiday.mp4',
    content_type: 'video/mp4',
    part_count: 3,
    ...overrides,
  };
}
