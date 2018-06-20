/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

// The ideal input response latency, the time between the input task and the
// first frame of the response.
const BASE_RESPONSE_LATENCY = 16;
const SCHEDULABLE_TASK_TITLE = 'TaskQueueManager::ProcessTaskFromWorkQueue';
const SCHEDULABLE_TASK_TITLE_ALT = 'ThreadControllerImpl::DoWork';
const LHError = require('../errors');
const {taskGroups, taskNameToGroup} = require('../task-groups');

/** @typedef {import('../task-groups.js').TaskGroup} TaskGroup */

class TraceProcessor {
  /**
   * @param {LH.TraceEvent} event
   * @param {TaskNode} [parent]
   * @return {TaskNode}
   */
  static _createNewTaskNode(event, parent) {
    const newTask = {
      event,
      startTime: event.ts,
      endTime: event.ph === 'X' ? event.ts + Number(event.dur || 0) : NaN,
      parent: parent,
      children: [],

      // These properties will be filled in later
      group: taskGroups.Other,
      attributableURL: undefined,
      duration: NaN,
      selfTime: NaN,
    };

    if (parent) {
      parent.children.push(newTask);
    }

    return newTask;
  }

  /**
   * @param {LH.TraceEvent[]} traceEvents
   * @return {TaskNode[]}
   */
  static _createTasksFromEvents(traceEvents) {
    const {startedInPageEvt} = TraceProcessor.findTracingStartedEvt(traceEvents);

    /** @type {TaskNode[]} */
    const tasks = [];
    /** @type {TaskNode|undefined} */
    let currentTask;

    for (const event of traceEvents) {
      // Only look at main thread events
      if (event.pid !== startedInPageEvt.pid || event.tid !== startedInPageEvt.tid) continue;
      // Only look at X (Complete), B (Begin), and E (End) events as they have most data
      if (event.ph !== 'X' && event.ph !== 'B' && event.ph !== 'E') continue;

      // Update currentTask based on the elapsed time.
      // The next event may be after currentTask has ended.
      while (
        currentTask &&
        Number.isFinite(currentTask.endTime) &&
        currentTask.endTime <= event.ts
      ) {
        currentTask = currentTask.parent;
      }

      // If we don't have a current task, start a new one.
      if (!currentTask) {
        // We can't start a task with an end event
        if (event.ph === 'E') {
          throw new Error('Fatal trace logic error');
        }

        currentTask = TraceProcessor._createNewTaskNode(event);
        tasks.push(currentTask);

        continue;
      }

      if (event.ph === 'X' || event.ph === 'B') {
        // We're starting a nested event, create it as a child and make it the currentTask
        const newTask = TraceProcessor._createNewTaskNode(event, currentTask);
        tasks.push(newTask);
        currentTask = newTask;
      } else {
        if (currentTask.event.ph !== 'B') {
          throw new Error('Fatal trace logic error');
        }

        // We're ending an event, update the end time and the currentTask to its parent
        currentTask.endTime = event.ts;
        currentTask = currentTask.parent;
      }
    }

    return tasks;
  }

  /**
   * @param {TaskNode} task
   * @return {number}
   */
  static _computeRecursiveSelfTime(task) {
    const childTime = task.children
      .map(TraceProcessor._computeRecursiveSelfTime)
      .reduce((sum, child) => sum + child, 0);
    task.duration = task.endTime - task.startTime;
    task.selfTime = task.duration - childTime;
    return task.duration;
  }

  /**
   * @param {TaskNode} task
   * @param {string} [parentURL]
   */
  static _computeRecursiveAttributableURL(task, parentURL) {
    const argsData = task.event.args.data || {};
    const stackFrames = argsData.stackTrace || [{url: undefined}];
    const taskURL = argsData.url || (stackFrames[0] && stackFrames[0].url);

    task.attributableURL = parentURL || taskURL;
    task.children.forEach(child =>
      TraceProcessor._computeRecursiveAttributableURL(child, task.attributableURL));
  }

  /**
   * @param {TaskNode} task
   * @param {TaskGroup} [parentGroup]
   */
  static _computeRecursiveTaskGroup(task, parentGroup) {
    const group = taskNameToGroup[task.event.name];
    task.group = group || parentGroup || taskGroups.Other;
    task.children.forEach(child => TraceProcessor._computeRecursiveTaskGroup(child, task.group));
  }

  /**
   *
   * @param {LH.TraceEvent[]} traceEvents
   * @return {TaskNode[]}
   */
  static getMainThreadTasks(traceEvents) {
    const tasks = TraceProcessor._createTasksFromEvents(traceEvents);

    // Compute the recursive properties we couldn't compute earlier, starting at the toplevel tasks
    for (const task of tasks) {
      if (task.parent) continue;

      TraceProcessor._computeRecursiveSelfTime(task);
      TraceProcessor._computeRecursiveAttributableURL(task);
      TraceProcessor._computeRecursiveTaskGroup(task);
    }

    const firstTs = (tasks[0] || {startTime: 0}).startTime;
    for (const task of tasks) {
      task.startTime = (task.startTime - firstTs) / 1000;
      task.endTime = (task.endTime - firstTs) / 1000;
      task.duration /= 1000;
      task.selfTime /= 1000;

      // sanity check that we have selfTime which captures all other timing data
      if (!Number.isFinite(task.selfTime)) {
        throw new Error('Invalid task timing data');
      }
    }

    return tasks;
  }

  /**
   * Calculate duration at specified percentiles for given population of
   * durations.
   * If one of the durations overlaps the end of the window, the full
   * duration should be in the duration array, but the length not included
   * within the window should be given as `clippedLength`. For instance, if a
   * 50ms duration occurs 10ms before the end of the window, `50` should be in
   * the `durations` array, and `clippedLength` should be set to 40.
   * @see https://docs.google.com/document/d/1b9slyaB9yho91YTOkAQfpCdULFkZM9LqsipcX3t7He8/preview
   * @param {!Array<number>} durations Array of durations, sorted in ascending order.
   * @param {number} totalTime Total time (in ms) of interval containing durations.
   * @param {!Array<number>} percentiles Array of percentiles of interest, in ascending order.
   * @param {number=} clippedLength Optional length clipped from a duration overlapping end of window. Default of 0.
   * @return {!Array<{percentile: number, time: number}>}
   * @private
   */
  static _riskPercentiles(durations, totalTime, percentiles, clippedLength = 0) {
    let busyTime = 0;
    for (let i = 0; i < durations.length; i++) {
      busyTime += durations[i];
    }
    busyTime -= clippedLength;

    // Start with idle time already complete.
    let completedTime = totalTime - busyTime;
    let duration = 0;
    let cdfTime = completedTime;
    const results = [];

    let durationIndex = -1;
    let remainingCount = durations.length + 1;
    if (clippedLength > 0) {
      // If there was a clipped duration, one less in count since one hasn't started yet.
      remainingCount--;
    }

    // Find percentiles of interest, in order.
    for (const percentile of percentiles) {
      // Loop over durations, calculating a CDF value for each until it is above
      // the target percentile.
      const percentileTime = percentile * totalTime;
      while (cdfTime < percentileTime && durationIndex < durations.length - 1) {
        completedTime += duration;
        remainingCount -= (duration < 0 ? -1 : 1);

        if (clippedLength > 0 && clippedLength < durations[durationIndex + 1]) {
          duration = -clippedLength;
          clippedLength = 0;
        } else {
          durationIndex++;
          duration = durations[durationIndex];
        }

        // Calculate value of CDF (multiplied by totalTime) for the end of this duration.
        cdfTime = completedTime + Math.abs(duration) * remainingCount;
      }

      // Negative results are within idle time (0ms wait by definition), so clamp at zero.
      results.push({
        percentile,
        time: Math.max(0, (percentileTime - completedTime) / remainingCount) +
          BASE_RESPONSE_LATENCY,
      });
    }

    return results;
  }

  /**
   * Calculates the maximum queueing time (in ms) of high priority tasks for
   * selected percentiles within a window of the main thread.
   * @see https://docs.google.com/document/d/1b9slyaB9yho91YTOkAQfpCdULFkZM9LqsipcX3t7He8/preview
   * @param {Array<ToplevelEvent>} events
   * @param {number} startTime Start time (in ms relative to navstart) of range of interest.
   * @param {number} endTime End time (in ms relative to navstart) of range of interest.
   * @param {!Array<number>=} percentiles Optional array of percentiles to compute. Defaults to [0.5, 0.75, 0.9, 0.99, 1].
   * @return {!Array<{percentile: number, time: number}>}
   */
  static getRiskToResponsiveness(
      events,
      startTime,
      endTime,
      percentiles = [0.5, 0.75, 0.9, 0.99, 1]
  ) {
    const totalTime = endTime - startTime;
    percentiles.sort((a, b) => a - b);

    const ret = TraceProcessor.getMainThreadTopLevelEventDurations(events, startTime, endTime);
    return TraceProcessor._riskPercentiles(ret.durations, totalTime, percentiles,
        ret.clippedLength);
  }

  /**
   * Provides durations in ms of all main thread top-level events
   * @param {Array<ToplevelEvent>} topLevelEvents
   * @param {number} startTime Optional start time (in ms relative to navstart) of range of interest. Defaults to navstart.
   * @param {number} endTime Optional end time (in ms relative to navstart) of range of interest. Defaults to trace end.
   * @return {{durations: Array<number>, clippedLength: number}}
   */
  static getMainThreadTopLevelEventDurations(topLevelEvents, startTime = 0, endTime = Infinity) {
    // Find durations of all slices in range of interest.
    /** @type {Array<number>} */
    const durations = [];
    let clippedLength = 0;

    for (const event of topLevelEvents) {
      if (event.end < startTime || event.start > endTime) {
        continue;
      }

      let duration = event.duration;
      let eventStart = event.start;
      if (eventStart < startTime) {
        // Any part of task before window can be discarded.
        eventStart = startTime;
        duration = event.end - startTime;
      }

      if (event.end > endTime) {
        // Any part of task after window must be clipped but accounted for.
        clippedLength = duration - (endTime - eventStart);
      }

      durations.push(duration);
    }
    durations.sort((a, b) => a - b);

    return {
      durations,
      clippedLength,
    };
  }

  /**
   * Provides the top level events on the main thread with timestamps in ms relative to navigation
   * start.
   * @param {LH.Artifacts.TraceOfTab} tabTrace
   * @param {number=} startTime Optional start time (in ms relative to navstart) of range of interest. Defaults to navstart.
   * @param {number=} endTime Optional end time (in ms relative to navstart) of range of interest. Defaults to trace end.
   * @return {Array<ToplevelEvent>}
   */
  static getMainThreadTopLevelEvents(tabTrace, startTime = 0, endTime = Infinity) {
    const topLevelEvents = [];
    // note: mainThreadEvents is already sorted by event start
    for (const event of tabTrace.mainThreadEvents) {
      if (!TraceProcessor.isScheduleableTask(event) || !event.dur) continue;

      const start = (event.ts - tabTrace.navigationStartEvt.ts) / 1000;
      const end = (event.ts + event.dur - tabTrace.navigationStartEvt.ts) / 1000;
      if (start > endTime || end < startTime) continue;

      topLevelEvents.push({
        start,
        end,
        duration: event.dur / 1000,
      });
    }

    // There should *always* be at least one top level event, having 0 typically means something is
    // drastically wrong with the trace and would should just give up early and loudly.
    if (!topLevelEvents.length) {
      throw new Error('Could not find any top level events');
    }

    return topLevelEvents;
  }

  /**
   * @param {LH.TraceEvent[]} events
   * @return {{startedInPageEvt: LH.TraceEvent, frameId: string}}
   */
  static findTracingStartedEvt(events) {
    /** @type {LH.TraceEvent|undefined} */
    let startedInPageEvt;

    // Prefer the newer TracingStartedInBrowser event first, if it exists
    const startedInBrowserEvt = events.find(e => e.name === 'TracingStartedInBrowser');
    if (startedInBrowserEvt && startedInBrowserEvt.args.data &&
        startedInBrowserEvt.args.data.frames) {
      const mainFrame = startedInBrowserEvt.args.data.frames.find(frame => !frame.parent);
      const pid = mainFrame && mainFrame.processId;
      const threadNameEvt = events.find(e => e.pid === pid && e.ph === 'M' &&
        e.cat === '__metadata' && e.name === 'thread_name' && e.args.name === 'CrRendererMain');
      startedInPageEvt = mainFrame && threadNameEvt ?
        Object.assign({}, startedInBrowserEvt, {
          pid, tid: threadNameEvt.tid, name: 'TracingStartedInPage',
          args: {data: {page: mainFrame.frame}}}) :
        undefined;
    }

    // Support legacy browser versions that do not emit TracingStartedInBrowser event.
    if (!startedInPageEvt) {
      // The first TracingStartedInPage in the trace is definitely our renderer thread of interest
      // Beware: the tracingStartedInPage event can appear slightly after a navigationStart
      startedInPageEvt = events.find(e => e.name === 'TracingStartedInPage');
    }

    if (!startedInPageEvt) throw new LHError(LHError.errors.NO_TRACING_STARTED);

    // @ts-ignore - property chain exists for 'TracingStartedInPage' event.
    const frameId = /** @type {string} */ (startedInPageEvt.args.data.page);
    return {startedInPageEvt, frameId};
  }

  /**
   * @param {LH.TraceEvent} evt
   * @return {boolean}
   */
  static isScheduleableTask(evt) {
    return evt.name === SCHEDULABLE_TASK_TITLE || evt.name === SCHEDULABLE_TASK_TITLE_ALT;
  }
}

/**
 * @typedef ToplevelEvent
 * @prop {number} start
 * @prop {number} end
 * @prop {number} duration
 */

/**
 * @typedef TaskNode
 * @prop {LH.TraceEvent} event
 * @prop {TaskNode[]} children
 * @prop {TaskNode|undefined} parent
 * @prop {number} startTime
 * @prop {number} endTime
 * @prop {number} duration
 * @prop {number} selfTime
 * @prop {string|undefined} attributableURL
 * @prop {TaskGroup} group
 */

module.exports = TraceProcessor;
