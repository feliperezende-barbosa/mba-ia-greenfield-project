import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Video } from '../videos/entities/video.entity';
import {
  ENQUEUE_TIMEOUT_MS,
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import type { ProcessVideoJobData } from './video-processing.types';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  // The video uuid is the jobId: BullMQ silently ignores an add() for an existing id.
  // BullMQ keeps reconnecting forever and add() waits for the connection, so the
  // wait is bounded to make an unreachable Redis surface as an error.
  async enqueue(video: Pick<Video, 'id' | 'public_id'>): Promise<void> {
    const pendingAdd = this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id, publicId: video.public_id },
      { jobId: video.id },
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Publishing job ${PROCESS_VIDEO_JOB} timed out after ${ENQUEUE_TIMEOUT_MS}ms`,
            ),
          ),
        ENQUEUE_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([pendingAdd, timeout]);
    } finally {
      clearTimeout(timer);
      // An add() that loses the race must not become an unhandled rejection later.
      pendingAdd.catch(() => undefined);
    }
  }
}
