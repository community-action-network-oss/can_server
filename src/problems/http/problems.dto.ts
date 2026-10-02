import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class HelpNeededDto {
  @ApiProperty({ type: [String] }) skill_groups!: string[];
  @ApiProperty({ type: [String] }) languages!: string[];
  @ApiProperty({ type: String, nullable: true }) coarse_place!: string | null;
  @ApiProperty({ type: [String] }) topics!: string[];
}

export class PublicProblemDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() state!: string;
  @ApiProperty() publishedAt!: string;
  @ApiProperty({ type: HelpNeededDto }) help_needed!: HelpNeededDto;
}

export class PublicProblemPageDto {
  @ApiProperty({ type: [PublicProblemDto] }) items!: PublicProblemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

/** The only inputs: paging and a public coarse region shard. Never a profile (PROFILE-LOCAL-1). */
export class ListProblemsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() limit?: string;
  @ApiPropertyOptional({ description: 'Public coarse region shard id.' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/)
  region?: string;
}
