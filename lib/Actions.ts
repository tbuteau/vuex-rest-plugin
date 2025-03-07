import { ActionContext, Commit, ActionTree, Action } from "vuex";
import { AxiosInstance, Method } from "axios";
import at from "lodash-es/at";
import cloneDeep from "lodash-es/cloneDeep";
import flatMap from "lodash-es/flatMap";
import forEach from "lodash-es/forEach";
import get from "lodash-es/get";
import has from "lodash-es/has";
import isArray from "lodash-es/isArray";
import keys from "lodash-es/keys";
import map from "lodash-es/map";
import values from "lodash-es/values";
import ApiState from "./ApiState";
import {
  IndexedObject,
  ModelTypeTree,
  Payload,
  QueuePayload,
  QueuePayloadWithModifiers,
  ModelType,
  ModifierName
} from "./types";
import { applyModifier, formatUrl } from "./utils";

class ActionBase<S, R> {
  private _axios: AxiosInstance;
  private _models: ModelTypeTree;
  private _dataPath = "data";
  constructor(axios: AxiosInstance, models: ModelTypeTree, dataPath?: string) {
    this._axios = axios;
    this._models = models;
    if (dataPath) {
      this._dataPath = `${this._dataPath}.${dataPath}`;
    }

    // add watched changes to queue
    // this.queueActionWatcher = (
    //   { commit, state }: ActionContext<S, R>,
    //   payload: QueuePayload
    // ) => {
    //   const model = _getModel(payload);
    //   const checkChanged = (i: IndexedObject) =>
    //     has(get(state, `${model.plural}.originItems`), i.id) &&
    //     !isEqual(get(state, `${model.plural}.originItems.${i.id}`), i);
    //   const hasChanged =
    //     isArray(payload.data) && payload.data
    //       ? some(payload.data, checkChanged)
    //       : checkChanged(payload.data);
    //   if (hasChanged) {
    //     commit(`QUEUE_ACTION_${model.name}`, payload);
    //   }
    // };
  }

  _isAll(p: Payload) {
    return !has(p, "id") && isArray(p.data);
  }

  _getModel(p: Payload | QueuePayload): ModelType {
    return this._models[p.type];
  }

  // retrieve entity from Vuex store
  _getEntity(state: S | ApiState, payload: Payload) {
    return get(state, `${this._getModel(payload).plural}.items`)[payload.id];
  }

  async _addToStore(
    commit: Commit,
    type: string,
    path: string,
    data: IndexedObject | Array<IndexedObject>
  ) {
    const modified = await applyModifier(
      ModifierName.afterGet,
      type,
      this._models,
      data
    );
    commit(`SAVE_ORIGIN_${path}`, cloneDeep(modified));
    commit(`ADD_${path}`, modified);
  }

  // fetch entity from API
  async _fetchEntity(commit: Commit, payload: Payload) {
    if (get(payload, "clear", this._isAll(payload))) {
      commit(`CLEAR_${this._getModel(payload).name.toUpperCase()}`);
    }
    const result = await this._axios.get(
      formatUrl(payload),
      payload.axiosConfig
    );
    const resultData = get(result, this._dataPath);
    this._addToStore(
      commit,
      payload.type,
      this._getModel(payload).name.toUpperCase(),
      resultData
    );
    return resultData;
  }

  // add Entity to Store
  async _addEntity(commit: Commit, payload: Payload) {
    if (get(payload, "clear")) {
      commit(`CLEAR_${this._getModel(payload).name.toUpperCase()}`);
    }
    if (payload.data) {
      this._addToStore(
        commit,
        payload.type,
        this._getModel(payload).name.toUpperCase(),
        payload.data
      );
    }

    return payload.data;
  }

  // store entity to API
  async _storeEntity(
    commit: Commit,
    payload: Payload,
    method: Method = "post"
  ) {
    const mainConfig = {
      method,
      url: formatUrl(payload),
      data: await applyModifier(
        ModifierName.beforeSave,
        payload.type,
        this._models,
        payload.data
      )
    };
    const config = { ...mainConfig, ...payload.axiosConfig };
    const result = await this._axios(config);
    const resultData = get(result, this._dataPath);
    this._addToStore(
      commit,
      payload.type,
      this._getModel(payload).name.toUpperCase(),
      resultData
    );
    return resultData;
  }

  // delete entity to API
  async _deleteEntity(commit: Commit, payload: Payload) {
    const model = this._getModel(payload);
    const { id, data } = payload;

    if (this._isAll(payload)) {
      return this._axios
        .patch(
          `${formatUrl(payload)}/delete`,
          await applyModifier(
            ModifierName.beforeSave,
            payload.type,
            this._models,
            data
          ),
          payload.axiosConfig
        )
        .then(() => {
          commit(`DELETE_${model.name.toUpperCase()}`, data);
        });
    }

    return this._axios
      .delete(formatUrl(payload), payload.axiosConfig)
      .then(() => {
        commit(`DELETE_${model.name.toUpperCase()}`, id);
      });
  }

  async _getQueuePayloadWithModifiers({
    data,
    type,
    url,
    action
  }: QueuePayload): Promise<QueuePayloadWithModifiers> {
    const afterGet = await applyModifier(
      ModifierName.afterGet,
      type,
      this._models,
      data
    );

    return {
      action,
      id: data.id,
      afterGet,
      toQueue: {
        type,
        url,
        data: await applyModifier(
          ModifierName.beforeSave,
          type,
          this._models,
          data
        )
      }
    };
  }

  _processAction(action: Method, payload: Payload, commit: Commit) {
    if (action === "delete") {
      return this._deleteEntity(commit, payload);
    }
    return this._storeEntity(commit, payload, action);
  }

  _confirmActionType(
    queue: string,
    { state, commit }: ActionContext<S, R>,
    sequential = false
  ) {
    const model = this._models[queue];
    if (get(state, `${model.plural}.hasAction`)) {
      const queues = get(state, `${model.plural}.actionQueue`);

      // eslint-disable-next-line
      let p: Promise<any> = Promise.resolve();

      if (sequential) {
        flatMap(queues, (entities: Array<QueuePayload>, action: Method) =>
          map(entities, async entity => {
            const payload = { id: entity.data.id, ...entity };
            p = p.then(() =>
              Promise.resolve(this._processAction(action, payload, commit))
            );
          })
        );
      } else {
        p = p.then(() =>
          Promise.all(
            flatMap(queues, (entities: Array<QueuePayload>, action: Method) =>
              map(entities, async entity => {
                const payload = { id: entity.data.id, ...entity };
                this._processAction(action, payload, commit);
              })
            )
          )
        );
      }
      return p.then(() => commit(`RESET_QUEUE_${model.name}`));
    }
    return Promise.resolve();
  }

  async _cancelActionType(
    queue: string,
    { state, commit }: ActionContext<S, R>
  ) {
    const model = this._models[queue];
    if (get(state, `${model.plural}.hasAction`)) {
      const originIds = keys(
        get(state, `${model.plural}.actionQueue.delete`, [])
      ).concat(
        keys(get(state, `${model.plural}.actionQueue.post`, [])),
        keys(get(state, `${model.plural}.actionQueue.patch`, []))
      );
      const origin = at(get(state, `${model.plural}.originItems`), originIds);
      commit(
        `ADD_${model.name}`,
        await applyModifier(
          ModifierName.afterQueue,
          queue,
          this._models,
          origin
        )
      );
      commit(`RESET_QUEUE_${model.name}`);
    }
  }
}

export default class Actions<S, R> implements ActionTree<S, R> {
  [key: string]: Action<S, R>;
  get: Action<S, R>;
  post: Action<S, R>;
  patch: Action<S, R>;
  delete: Action<S, R>;
  add: Action<S, R>;
  // queueActionWatcher: Action<S, R>;
  queueAction: Action<S, R>;
  processActionQueue: Action<S, R>;
  sequentialProcessActionQueue: Action<S, R>;
  cancelAction: Action<S, R>;
  cancelActionQueue: Action<S, R>;
  reset: Action<S, R>;
  constructor(axios: AxiosInstance, models: ModelTypeTree, dataPath?: string) {
    const base = new ActionBase(axios, models, dataPath);
    this.get = async (
      { commit, state }: ActionContext<S, R>,
      payload: Payload
    ) => {
      const entity = base._getEntity(state, payload);
      if (payload.forceFetch || !entity) {
        return base._fetchEntity(commit, payload);
      } else {
        return entity;
      }
    };

    this.post = ({ commit }: ActionContext<S, R>, payload: Payload) => {
      return base._storeEntity(commit, payload);
    };

    this.patch = ({ commit }: ActionContext<S, R>, payload: Payload) => {
      return base._storeEntity(commit, payload, "patch");
    };

    this.delete = ({ commit }: ActionContext<S, R>, payload: Payload) => {
      return base._deleteEntity(commit, payload);
    };

    this.add = ({ commit }: ActionContext<S, R>, payload: Payload) => {
      return base._addEntity(commit, payload);
    };

    this.queueAction = async (
      { commit }: ActionContext<S, R>,
      payload: QueuePayload
    ) => {
      return commit(
        `QUEUE_ACTION_${base._getModel(payload).name}`,
        await base._getQueuePayloadWithModifiers(payload)
      );
    };

    this.processAction = (
      { commit }: ActionContext<S, R>,
      payload: QueuePayload
    ) => {
      return base._processAction(payload.action, payload.payload, commit);
    };

    this.processActionQueue = (
      context: ActionContext<S, R>,
      queue: string | Array<string>
    ) => {
      if (isArray(queue)) {
        return Promise.all(
          flatMap(queue, q => base._confirmActionType(q, context))
        );
      }
      return base._confirmActionType(queue, context);
    };

    this.sequentialProcessActionQueue = (
      context: ActionContext<S, R>,
      queue: string | Array<string>
    ) => {
      if (isArray(queue)) {
        return Promise.all(
          flatMap(queue, q => base._confirmActionType(q, context, true))
        );
      }
      return base._confirmActionType(queue, context, true);
    };

    this.cancelActionQueue = (
      context: ActionContext<S, R>,
      payload: string | Array<string>
    ) => {
      if (isArray(payload)) {
        forEach(payload, p => base._cancelActionType(p, context));
      } else {
        base._cancelActionType(payload, context);
      }
    };

    this.cancelAction = (
      { commit }: ActionContext<S, R>,
      payload: QueuePayload
    ) => {
      const model = base._getModel(payload);
      commit(`UNQUEUE_ACTION_${model.name}`, payload);
    };

    this.reset = (context: ActionContext<S, R>) => {
      values(context.state).forEach(s => s.reset());
    };
  }
}
