import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import {
  PROCESS_VIDEO_ATTEMPTS,
  PROCESS_VIDEO_BACKOFF_DELAY_MS,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_REMOVE_ON_COMPLETE_COUNT,
  VIDEO_PROCESSING_REMOVE_ON_FAIL_COUNT,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule.forFeature(queueConfig)],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
        prefix: config.prefix,
      }),
    }),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: {
        attempts: PROCESS_VIDEO_ATTEMPTS,
        backoff: { type: 'exponential', delay: PROCESS_VIDEO_BACKOFF_DELAY_MS },
        removeOnComplete: VIDEO_PROCESSING_REMOVE_ON_COMPLETE_COUNT,
        removeOnFail: VIDEO_PROCESSING_REMOVE_ON_FAIL_COUNT,
      },
    }),
  ],
  providers: [VideoProcessingProducer],
  exports: [BullModule, VideoProcessingProducer],
})
export class QueueModule {}
