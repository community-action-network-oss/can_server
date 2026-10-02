import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors } from '../../platform/errors.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import { Authenticated } from '../../platform/security/decorators.js';
import { PosterReviewService } from '../app/poster-review.service.js';
import { ReviewService } from '../app/review.service.js';
import {
  CreateRecommendationDto,
  CreatedRecommendationDto,
  DeclareDto,
  FinishDto,
  FinishedDto,
  MaskedProblemDto,
  MyReviewDto,
  OptInDto,
  PosterRecommendationsDto,
  PublicationRequestedDto,
  QueueDto,
  ResolveDto,
  ResolvedDto,
  ReviewStatusDto,
  SessionDto,
} from './review.dto.js';

const who = (r: AuthedRequest) => r.auth!.accountId;

// Everything review lives under /v1/review, /v1/me and /v1/recommendations: /v1/problems* stays 3 public GETs (PROFILE-LOCAL-1).
@ApiTags('review')
@Controller('v1/review')
export class ReviewController {
  constructor(@Inject(ReviewService) private readonly review: ReviewService) {}

  @Get('queue')
  @Authenticated()
  @ApiOperation({
    operationId: 'getReviewQueue',
    summary: 'Problems waiting for volunteer review, random order, masked',
  })
  @ApiOkResponse({ type: QueueDto })
  @ApiErrors(401, 403, 429, 500, 503)
  queue(@Req() req: AuthedRequest): Promise<QueueDto> {
    return this.review.queue(who(req));
  }

  @Post(':problemId/session')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'startReviewSession',
    summary: 'Declare no conflict of interest and open a review',
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiErrors(400, 401, 403, 404, 429, 500)
  session(
    @Param('problemId') id: string,
    @Body() b: DeclareDto,
    @Req() req: AuthedRequest,
  ): Promise<SessionDto> {
    return this.review.declare(who(req), id, b.noConflict);
  }

  @Get(':problemId')
  @Authenticated()
  @ApiOperation({
    operationId: 'getReviewProblem',
    summary: 'The problem to review, with personal data masked',
  })
  @ApiOkResponse({ type: MaskedProblemDto })
  @ApiErrors(401, 403, 404, 429, 500, 503)
  view(
    @Param('problemId') id: string,
    @Req() req: AuthedRequest,
  ): Promise<MaskedProblemDto> {
    return this.review.view(who(req), id);
  }

  @Get(':problemId/recommendations')
  @Authenticated()
  @ApiOperation({
    operationId: 'getMyReview',
    summary: 'Your own recommendations and the answers to them',
  })
  @ApiOkResponse({ type: MyReviewDto })
  @ApiErrors(401, 403, 404, 429, 500)
  mine(
    @Param('problemId') id: string,
    @Req() req: AuthedRequest,
  ): Promise<MyReviewDto> {
    return this.review.mine(who(req), id);
  }

  @Post(':problemId/recommendations')
  @ApiOperation({
    operationId: 'createRecommendation',
    summary: 'Recommend one change to one part of the problem',
  })
  @ApiCreatedResponse({ type: CreatedRecommendationDto })
  @ApiErrors(400, 401, 403, 404, 409, 429, 500, 503)
  recommend(
    @Param('problemId') id: string,
    @Body() b: CreateRecommendationDto,
    @Req() req: AuthedRequest,
  ): Promise<CreatedRecommendationDto> {
    return this.review.recommend(who(req), id, b);
  }

  @Post(':problemId/finish')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'finishReview',
    summary: 'End your review with recommendations or with no changes',
  })
  @ApiOkResponse({ type: FinishedDto })
  @ApiErrors(400, 401, 403, 404, 409, 429, 500)
  finish(
    @Param('problemId') id: string,
    @Body() b: FinishDto,
    @Req() req: AuthedRequest,
  ): Promise<FinishedDto> {
    return this.review.finish(who(req), id, b.outcome);
  }
}

@ApiTags('review')
@Controller('v1/me/review-opt-in')
export class ReviewOptInController {
  constructor(@Inject(ReviewService) private readonly review: ReviewService) {}

  @Get()
  @Authenticated()
  @ApiOperation({
    operationId: 'getReviewOptIn',
    summary: 'Whether you volunteer to review',
  })
  @ApiOkResponse({ type: OptInDto })
  @ApiErrors(401, 429, 500)
  get(@Req() req: AuthedRequest): Promise<OptInDto> {
    return this.review.optInState(who(req));
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    operationId: 'optInToReview',
    summary: 'Volunteer to review problems',
  })
  @ApiOkResponse({ type: OptInDto })
  @ApiErrors(401, 429, 500)
  on(@Req() req: AuthedRequest): Promise<OptInDto> {
    return this.review.optIn(who(req), true);
  }

  @Delete()
  @ApiOperation({
    operationId: 'optOutOfReview',
    summary: 'Stop volunteering. Finished reviews stay counted.',
  })
  @ApiOkResponse({ type: OptInDto })
  @ApiErrors(401, 429, 500)
  off(@Req() req: AuthedRequest): Promise<OptInDto> {
    return this.review.optIn(who(req), false);
  }
}

@ApiTags('review')
@Controller('v1')
export class PosterReviewController {
  constructor(
    @Inject(PosterReviewService) private readonly poster: PosterReviewService,
  ) {}

  @Get('me/problems/:id/recommendations')
  @Authenticated()
  @ApiOperation({
    operationId: 'listMyProblemRecommendations',
    summary:
      'Recommendations on your problem; volunteers are numbered, never named',
  })
  @ApiOkResponse({ type: PosterRecommendationsDto })
  @ApiErrors(401, 404, 429, 500)
  list(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<PosterRecommendationsDto> {
    return this.poster.list(who(req), id);
  }

  @Post('recommendations/:id/resolve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'resolveRecommendation',
    summary: 'Accept or decline a recommendation, with a reason',
  })
  @ApiOkResponse({ type: ResolvedDto })
  @ApiErrors(400, 401, 404, 409, 429, 500, 503)
  resolve(
    @Param('id') id: string,
    @Body() b: ResolveDto,
    @Req() req: AuthedRequest,
  ): Promise<ResolvedDto> {
    return this.poster.resolve(who(req), id, b);
  }

  @Get('me/problems/:id/review-status')
  @Authenticated()
  @ApiOperation({
    operationId: 'getMyProblemReviewStatus',
    summary:
      'Review progress: counts, quorum and whether you can ask for publication',
  })
  @ApiOkResponse({ type: ReviewStatusDto })
  @ApiErrors(401, 404, 429, 500)
  status(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ReviewStatusDto> {
    return this.poster.status(who(req), id);
  }

  @Post('me/problems/:id/request-publication')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'requestPublication',
    summary: 'Ask for the publication decision once the review rule allows it',
  })
  @ApiOkResponse({ type: PublicationRequestedDto })
  @ApiErrors(401, 403, 404, 409, 429, 500)
  request(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<PublicationRequestedDto> {
    return this.poster.requestPublication(who(req), id);
  }
}
