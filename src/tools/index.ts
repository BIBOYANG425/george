export { createSquadPostTool } from './create-squad-post.js'
export { findSquadPostsTool } from './find-squad-posts.js'
export { joinSquadPostTool } from './join-squad-post.js'
export { squadRsvpTool } from './squad-rsvp.js'
export { lookupStudentTool } from './lookup-student.js'
export { updateProfileTool } from './update-profile.js'
export { suggestConnectionTool } from './suggest-connection.js'
export { searchEventsTool } from './search-events.js'
export { submitEventTool } from './submit-event.js'
export { getEventDetailsTool } from './get-event-details.js'
export { placesTool } from './places.js'
export { campusKnowledgeTool } from './campus-knowledge.js'
export { freshmanFaqTool } from './freshman-faq.js'
export { describeCourseTool } from './describe-course.js'
export { recommendCoursesTool } from './recommend-courses.js'
export { getRmpRatingsTool } from './get-rmp-ratings.js'
export { searchCoursesTool } from './search-courses.js'
export { searchGeCoursesTool } from './search-ge-courses.js'
export { searchProgramsTool } from './search-programs.js'
export { planScheduleTool } from './plan-schedule.js'
export { getStudentAcademicStateTool } from './get-student-academic-state.js'
export { courseTipsTool } from './course-tips.js'
export { getCourseReviewsTool } from './get-course-reviews.js'
export { searchRoommatesTool } from './search-roommates.js'
export { searchSubletsTool } from './search-sublets.js'
export { postSubletTool } from './post-sublet.js'
export { setReminderTool } from './set-reminder.js'
export { loadSkillTool } from './load-skill.js'
export { dpsZoneCheckTool } from './dps-zone-check.js'
export { distanceCompareTool } from './distance-compare.js'
export { safeRouteTool } from './safe-route.js'
export { findPlacesTool } from './find-places.js'

import { createSquadPostTool } from './create-squad-post.js'
import { findSquadPostsTool } from './find-squad-posts.js'
import { joinSquadPostTool } from './join-squad-post.js'
import { squadRsvpTool } from './squad-rsvp.js'
import { lookupStudentTool } from './lookup-student.js'
import { updateProfileTool } from './update-profile.js'
import { suggestConnectionTool } from './suggest-connection.js'
import { searchEventsTool } from './search-events.js'
import { submitEventTool } from './submit-event.js'
import { getEventDetailsTool } from './get-event-details.js'
import { placesTool } from './places.js'
import { campusKnowledgeTool } from './campus-knowledge.js'
import { freshmanFaqTool } from './freshman-faq.js'
import { describeCourseTool } from './describe-course.js'
import { recommendCoursesTool } from './recommend-courses.js'
import { getRmpRatingsTool } from './get-rmp-ratings.js'
import { searchCoursesTool } from './search-courses.js'
import { searchGeCoursesTool } from './search-ge-courses.js'
import { searchProgramsTool } from './search-programs.js'
import { planScheduleTool } from './plan-schedule.js'
import { getStudentAcademicStateTool } from './get-student-academic-state.js'
import { courseTipsTool } from './course-tips.js'
import { getCourseReviewsTool } from './get-course-reviews.js'
import { searchRoommatesTool } from './search-roommates.js'
import { searchSubletsTool } from './search-sublets.js'
import { postSubletTool } from './post-sublet.js'
import { setReminderTool } from './set-reminder.js'
import { loadSkillTool } from './load-skill.js'
import { dpsZoneCheckTool } from './dps-zone-check.js'
import { distanceCompareTool } from './distance-compare.js'
import { safeRouteTool } from './safe-route.js'
import { findPlacesTool } from './find-places.js'
import { geCandidatesTool } from './ge-candidates.js'

export const ALL_TOOLS = {
  create_squad_post: createSquadPostTool,
  find_squad_posts: findSquadPostsTool,
  join_squad_post: joinSquadPostTool,
  squad_rsvp: squadRsvpTool,
  lookup_student: lookupStudentTool,
  update_profile: updateProfileTool,
  suggest_connection: suggestConnectionTool,
  search_events: searchEventsTool,
  submit_event: submitEventTool,
  get_event_details: getEventDetailsTool,
  travel_time: placesTool,
  campus_knowledge: campusKnowledgeTool,
  freshman_faq: freshmanFaqTool,
  describe_course: describeCourseTool,
  recommend_courses: recommendCoursesTool,
  get_rmp_ratings: getRmpRatingsTool,
  search_courses: searchCoursesTool,
  search_ge_courses: searchGeCoursesTool,
  ge_candidates: geCandidatesTool,
  search_programs: searchProgramsTool,
  plan_schedule: planScheduleTool,
  get_student_academic_state: getStudentAcademicStateTool,
  course_tips: courseTipsTool,
  get_course_reviews: getCourseReviewsTool,
  search_roommates: searchRoommatesTool,
  search_sublets: searchSubletsTool,
  post_sublet: postSubletTool,
  set_reminder: setReminderTool,
  load_skill: loadSkillTool,
  dps_zone_check: dpsZoneCheckTool,
  distance_compare: distanceCompareTool,
  safe_route: safeRouteTool,
  find_places: findPlacesTool,
}
