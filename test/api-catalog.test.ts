// api-catalog.test.ts — Unit tests for the API Catalog: model parsing, the
// deterministic mock generator, and endpoint extraction over synthetic Dart
// that mirrors venio's real patterns (Dio calls, freezed models, @JsonKey,
// enums, Endpoints constants, interpolated paths).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelRegistry } from '../src/parser/models.ts';
import { mockForClass, mockValue, type Registry } from '../src/mock-gen.ts';
import { extractCatalog } from '../src/api-catalog.ts';

// ---- mock generator -------------------------------------------------------

function reg(models: Record<string, [string, string, string][]>, enums: Record<string, number> = {}): Registry {
  const m = new Map(
    Object.entries(models).map(([k, fs]) => [k, fs.map(([name, jsonKey, type]) => ({ name, jsonKey, type }))]),
  );
  return { models: m, enums: new Map(Object.entries(enums)) };
}

test('mockValue: primitives, lists, maps, nullability', () => {
  const r = reg({});
  assert.equal(mockValue('int', r, 'id').value, 1);
  assert.equal(mockValue('int', r, 'total').value, 0);
  assert.equal(mockValue('String', r, 'email').value, 'user@example.com');
  assert.equal(mockValue('bool', r, 'isActive').value, true);
  assert.equal(mockValue('double', r).value, 1.5);
  assert.equal(mockValue('DateTime', r, 'createdAt').value, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(mockValue('List<int>', r, 'ids').value, [0]);
  assert.deepEqual(mockValue('String?', r, 'name').value, 'Sample name');
  assert.deepEqual(mockValue('Map<String,int>', r, 'm').value, { key: 0 });
});

test('mockForClass: nested models + enums + cycle guard', () => {
  const r = reg(
    {
      User: [['id', 'Id', 'int'], ['name', 'Name', 'String'], ['role', 'Role', 'Role'], ['friend', 'Friend', 'User?']],
      Role: [], // not used as object — it's an enum below
    },
    { Role: 2 },
  );
  // Role is both an empty model and an enum; enum lookup only happens when a type
  // isn't a model, so make a clean registry for the enum case.
  const r2 = reg({ User: [['id', 'Id', 'int'], ['role', 'Role', 'Role'], ['self', 'Self', 'User']] }, { Role: 7 });
  const out = mockForClass('User', r2).value as Record<string, unknown>;
  assert.equal(out.Id, 1);
  assert.equal(out.Role, 7, 'enum field → first variant int value');
  assert.deepEqual(out.Self, {}, 'self-reference is cut by the cycle guard');
  assert.ok(r); // silence unused
});

test('mockForClass: unknown custom type marks partial', () => {
  const r = reg({ X: [['thing', 'thing', 'SomeUnparsedModel']] });
  const res = mockForClass('X', r);
  assert.equal(res.partial, true);
});

// ---- model registry parsing ----------------------------------------------

test('buildModelRegistry: freezed with @JsonKey, @Default, required, nested', () => {
  const dart = `
@freezed
abstract class AgendaItemModel with _$AgendaItemModel {
  const factory AgendaItemModel({
    @JsonKey(name: 'Id') int? id,
    @JsonKey(name: 'Subject') String? subject,
    @JsonKey(name: 'StartDate') DateTime? startDate,
    @JsonKey(name: 'Participants')
    @Default(<ParticipantModel>[])
    List<ParticipantModel> participants,
    required String tenantId,
  }) = _AgendaItemModel;
  factory AgendaItemModel.fromJson(Map<String, dynamic> json) => _$AgendaItemModelFromJson(json);
}`;
  const r = buildModelRegistry(new Map([['a.dart', dart]]));
  const f = r.models.get('AgendaItemModel');
  assert.ok(f, 'parsed AgendaItemModel');
  const byKey = Object.fromEntries(f!.map((x) => [x.jsonKey, x.type]));
  assert.equal(byKey['Id'], 'int?');
  assert.equal(byKey['Subject'], 'String?');
  assert.equal(byKey['StartDate'], 'DateTime?');
  assert.equal(byKey['Participants'], 'List<ParticipantModel>');
  assert.equal(byKey['tenantId'], 'String', 'no @JsonKey → field name is the key');
});

test('buildModelRegistry: plain class with final fields + enum int value', () => {
  const dart = `
class UserInfoModel {
  const UserInfoModel({required this.userId, this.employeeId});
  factory UserInfoModel.fromJson(Map<String, dynamic> json) => UserInfoModel(userId: json['UserId']);
  final String userId;
  final int? employeeId;
  final List<int> permissions;
}
enum DynamicCustomFieldType { textField(1), singleSelect(2), multiSelect(3); }`;
  const r = buildModelRegistry(new Map([['u.dart', dart]]));
  const f = r.models.get('UserInfoModel');
  assert.ok(f);
  const names = f!.map((x) => x.name).sort();
  assert.deepEqual(names, ['employeeId', 'permissions', 'userId']);
  assert.equal(r.enums.get('DynamicCustomFieldType'), 1, 'first enum variant int');
});

// ---- endpoint extraction --------------------------------------------------

const DATASOURCE = `
class FooRemoteDataSourceImpl {
  FooRemoteDataSourceImpl({required Dio tenantClient}) : _tenant = tenantClient;
  final Dio _tenant;

  Future<UserModel> getUser(int id) async {
    final response = await _tenant.get<dynamic>('users/userinfo/\$id');
    return UserModel.fromJson(unwrapEnvelope(response));
  }

  Future<List<UserModel>> listUsers() async {
    final response = await _tenant.get<dynamic>(
      'users/list',
      queryParameters: {'skip': skip, 'take': take},
    );
    return _unwrapList(response, UserModel.fromJson);
  }

  Future<void> register(String token) async {
    await _tenant.post<dynamic>('user/notification/register', data: {'Token': token, 'AppId': 4001});
  }

  Future<CreateResultModel> create(CreateReq req) async {
    final body = CreateReq(name: 'x');
    final response = await _tenant.post<dynamic>(CustomerEndpoints.createCustomer(), data: body.toJson());
    return CreateResultModel.fromJson(response.data);
  }
}`;

const MODELS = `
@freezed
abstract class UserModel with _\$UserModel {
  const factory UserModel({
    @JsonKey(name: 'UserId') int? userId,
    @JsonKey(name: 'DisplayName') String? displayName,
  }) = _UserModel;
}
@freezed
abstract class CreateReq with _\$CreateReq {
  const factory CreateReq({ required String name }) = _CreateReq;
}
@freezed
abstract class CreateResultModel with _\$CreateResultModel {
  const factory CreateResultModel({ @JsonKey(name: 'Id') int? id }) = _CreateResultModel;
}`;

const ENDPOINTS = `
class CustomerEndpoints {
  static String createCustomer() => 'v2/Customer/Create';
}`;

function catalog() {
  const contents = new Map<string, string>([
    ['lib/src/data/datasources/foo_remote_datasource_impl.dart', DATASOURCE],
    ['lib/src/data/models/models.dart', MODELS],
    ['lib/src/data/datasources/customer_endpoints.dart', ENDPOINTS],
  ]);
  return extractCatalog(contents, new Map([['lib/src/data/datasources/foo_remote_datasource_impl.dart', 'foo']]));
}

test('extractCatalog: methods, interpolated path, response type + mock', () => {
  const cat = catalog();
  const byId = Object.fromEntries(cat.endpoints.map((e) => [e.id, e]));

  const getUser = byId['GET users/userinfo/{id}'];
  assert.ok(getUser, 'interpolated $id normalized to {id}');
  assert.equal(getUser.responseType, 'UserModel');
  // mock values are derived from the Dart FIELD name (the hint), not the JSON key.
  assert.deepEqual(getUser.mockResponse, { UserId: 0, DisplayName: 'Sample displayName' });
  assert.equal(getUser.service, 'FooRemoteDataSourceImpl');
  assert.equal(getUser.feature, 'foo');

  const list = byId['GET users/list'];
  assert.ok(list);
  assert.equal(list.responseIsList, true);
  assert.deepEqual(list.mockResponse, [{ UserId: 0, DisplayName: 'Sample displayName' }]);
  assert.deepEqual(list.mockQuery, { skip: 1, take: 1 });
});

test('extractCatalog: void → empty response; inline data map', () => {
  const cat = catalog();
  const reg = cat.endpoints.find((e) => e.path === 'user/notification/register');
  assert.ok(reg);
  assert.equal(reg!.method, 'POST');
  assert.deepEqual(reg!.mockResponse, {});
  assert.deepEqual(reg!.mockRequest, { Token: 'string', AppId: 4001 });
});

test('extractCatalog: Endpoints constant resolves + toJson request model', () => {
  const cat = catalog();
  const create = cat.endpoints.find((e) => e.path === 'v2/Customer/Create');
  assert.ok(create, 'CustomerEndpoints.createCustomer() resolved to its path');
  assert.equal(create!.method, 'POST');
  assert.equal(create!.requestType, 'CreateReq');
  assert.deepEqual(create!.mockRequest, { name: 'Sample name' });
  assert.equal(create!.responseType, 'CreateResultModel');
});

test('extractCatalog: stats count methods', () => {
  const cat = catalog();
  assert.equal(cat.stats.total, cat.endpoints.length);
  assert.ok(cat.stats.GET >= 2);
  assert.ok(cat.stats.POST >= 2);
});
