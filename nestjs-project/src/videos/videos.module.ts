import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideosRepository } from './videos.repository';

@Module({
  imports: [TypeOrmModule.forFeature([Video])],
  providers: [VideosRepository],
  exports: [VideosRepository],
})
export class VideosModule {}
