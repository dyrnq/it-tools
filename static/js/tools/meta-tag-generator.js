/* ==========================================================================
   Open Graph / Twitter 卡片 meta 标签生成器（meta-tag-generator）

   填一张表，实时产出可以直接贴进 <head> 的 og: 与 twitter: 标签。
   页面类型可切换，切换后按类型追加对应的分区（文章 / 书籍 / 人物档案 /
   音乐 / 视频），字段表是从参考实现逐份搬过来的。

   参考实现：src/tools/meta-tag-generator/（it-tools, GPLv3）
   实际生成由全局 oggen（@it-tools/oggen 的 generateMeta 本体）完成：
       generateMeta({ ...ogMetadata, twitter: twitterMetadata },
                    { generateTwitterCompatibleMeta: true })
   它会把没有 twitter 专属字段的 og:title / og:description / og:image
   自动补成 twitter:title / twitter:description / twitter:image。

   —— 修正 oggen 的两个上游 bug（这一段是本模块与参考实现最实质的差别）——
   oggen 的输出违反 Open Graph 协议，而且是**两处都致命**的：贴进真实页面，
   Facebook / Twitter 一个字段都读不到，卡片完全不出现。

     1. 内容属性应该是 `content=`，oggen 输出的是 `value=`。
        （上游的 metaToString 把 `value="${value}"` 硬编码了。）
     2. 图片属性应该是 `og:image`，oggen 对 imgUrl 这个键输出的是
        `og:img_url`（它的 toSnakeCase 把驼峰拆成了下划线）。

   it-tools 原版是直接调库、原样透传，把这两个 bug 一起复制了过来。这个工具的
   产出是要被人真的贴进 <head> 的，所以值得多写一层后处理：fixMetaAttributes()
   在输出路径上把这两处改回来。库本身我们改不了（vendor 产物不许手改），所以
   修在输出这一侧。

   顺带说明一个**没有**在这里修的问题：oggen 对属性值不做任何转义，标题里出现
   一个双引号就会把标签本身截断（`<meta … value="he said "hi"" />`）。修它要
   动的是值的编码而不只是属性名，超出这次的范围，先记在这里。

   —— 与参考实现的差别 ——
   1. 参考实现的 watch 回调是 `watch(() => ref(metadata.value.type), ...)`：
      每次都 new 一个 ref 对象出来，Vue 的 watch 拿到的是个新引用，触发时机并
      不可靠；而且它清的是**上一个**类型的字段。这里改成确定性的做法：切换
      类型时清掉刚离开的那个类型的字段（只清「额外分区」的字段，website /
      image / twitter 三个常驻分区不动 —— 与参考实现清 `ogSchemas[type]` 的
      范围一致）。
   2. 参考实现用 lodash 的 `_.pickBy` 按插入顺序输出，而插入顺序取决于用户
      先填了哪个框。这里按字段表的声明顺序输出，所以同一份内容永远得到同一串
      标签。顺带这也让上一个类型的残留字段不会漏进输出。
   ========================================================================== */
(function () {
  'use strict';

  var D = window.ItTools.dom;
  var U = window.ItTools.util;
  var t = window.ItTools.t('meta-tag-generator');

  /** 页面类型下拉。分组用 <optgroup>，与参考实现的 SelectGroupOption 对应。 */
  var TYPE_OPTIONS = [
    { value: 'website', label: t('type_website', 'Website') },
    { value: 'article', label: t('type_article', 'Article') },
    { value: 'book', label: t('type_book', 'Book') },
    { value: 'profile', label: t('type_profile', 'Profile') },
    {
      group: t('group_music', 'Music'), options: [
        { value: 'music.song', label: t('type_song', 'Song') },
        { value: 'music.album', label: t('type_music_album', 'Music album') },
        { value: 'music.playlist', label: t('type_playlist', 'Playlist') },
        { value: 'music.radio_station', label: t('type_radio_station', 'Radio station') }
      ]
    },
    {
      group: t('group_video', 'Video'), options: [
        { value: 'video.movie', label: t('type_movie', 'Movie') },
        { value: 'video.episode', label: t('type_episode', 'Episode') },
        { value: 'video.tv_show', label: t('type_tv_show', 'TV show') },
        { value: 'video.other', label: t('type_other_video', 'Other video') }
      ]
    }
  ];

  /* 字段表，逐字段照抄参考实现 og-schemas/ 下的 15 个文件。
     key 就是要输出的 OG 属性名（oggen 会给它加上 og: / twitter: 前缀）。 */
  var SCHEMAS = {
    website: {
      name: t('section_general', 'General information'),
      elements: [
        { type: 'select', key: 'type', label: t('label_page_type', 'Page type'), placeholder: t('ph_page_type', 'Select the type of your website...'), options: TYPE_OPTIONS },
        { type: 'input', key: 'title', label: t('label_title', 'Title'), placeholder: t('ph_title', 'Enter the title of your website...') },
        { type: 'input', key: 'description', label: t('label_description', 'Description'), placeholder: t('ph_description', 'Enter the description of your website...') },
        { type: 'input', key: 'url', label: t('label_page_url', 'Page URL'), placeholder: t('ph_url', 'Enter the url of your website...') }
      ]
    },

    image: {
      name: t('section_image', 'Image'),
      elements: [
        { type: 'input', key: 'image', label: t('label_image_url', 'Image url'), placeholder: t('ph_image_url', 'The url of your website social image...') },
        { type: 'input', key: 'image:alt', label: t('label_image_alt', 'Image alt'), placeholder: t('ph_image_alt', 'The alternative text of your website social image...') },
        { type: 'input', key: 'image:width', label: t('label_width', 'Width'), placeholder: t('ph_width', 'Width in px of your website social image...') },
        { type: 'input', key: 'image:height', label: t('label_height', 'Height'), placeholder: t('ph_height', 'Height in px of your website social image...') }
      ]
    },

    twitter: {
      name: t('section_twitter', 'Twitter'),
      elements: [
        {
          type: 'select', key: 'twitter:card', label: t('label_card_type', 'Card type'),
          placeholder: t('ph_card_type', 'The Twitter card type...'),
          options: [
            { value: 'summary', label: t('card_summary', 'Summary') },
            { value: 'summary_large_image', label: t('card_summary_large_image', 'Summary with large image') },
            { value: 'app', label: t('card_application', 'Application') },
            { value: 'player', label: t('card_player', 'Player') }
          ]
        },
        { type: 'input', key: 'twitter:site', label: t('label_site_account', 'Site account'), placeholder: t('ph_site_account', 'The name of the Twitter account of the site (ex: @ittoolsdottech)...') },
        { type: 'input', key: 'twitter:creator', label: t('label_creator_acc', 'Creator acc.'), placeholder: t('ph_creator_acc', 'The name of the Twitter account of the creator (ex: @cthmsst)...') }
      ]
    },

    article: {
      name: t('section_article', 'Article'),
      elements: [
        { type: 'input', key: 'article:published_time', label: t('label_publishing_date', 'Publishing date'), placeholder: t('ph_publishing_date', 'When the article was first published...') },
        { type: 'input', key: 'article:modified_time', label: t('label_modification_date', 'Modification date'), placeholder: t('ph_modification_date', 'When the article was last changed...') },
        { type: 'input', key: 'article:expiration_time', label: t('label_expiration_date', 'Expiration date'), placeholder: t('ph_expiration_date', 'When the article is out of date after...') },
        { type: 'input', key: 'article:author', label: t('label_author', 'Author'), placeholder: t('ph_article_author', 'Writers of the article...') },
        { type: 'input', key: 'article:section', label: t('label_section', 'Section'), placeholder: t('ph_section', 'A high-level section name. E.g. Technology...') },
        { type: 'input', key: 'article:tag', label: t('label_tag', 'Tag'), placeholder: t('ph_article_tag', 'Tag words associated with this article...') }
      ]
    },

    book: {
      name: t('section_book', 'Book'),
      elements: [
        { type: 'input', key: 'book:author', label: t('label_author', 'Author'), placeholder: t('ph_book_author', 'Who wrote this book...') },
        { type: 'input', key: 'book:isbn', label: t('label_isbn', 'ISBN'), placeholder: t('ph_isbn', 'The International Standard Book Number...') },
        { type: 'input', key: 'book:release_date', label: t('label_release_date', 'Release date'), placeholder: t('ph_book_release_date', 'The date the book was released...') },
        { type: 'input', key: 'book:tag', label: t('label_tag', 'Tag'), placeholder: t('ph_book_tag', 'Tag words associated with this book...') }
      ]
    },

    profile: {
      name: t('section_profile', 'Profile'),
      elements: [
        { type: 'input', key: 'profile:first_name', label: t('label_first_name', 'First name'), placeholder: t('ph_first_name', 'Enter the first name of the person...') },
        { type: 'input', key: 'profile:last_name', label: t('label_last_name', 'Last name'), placeholder: t('ph_last_name', 'Enter the last name of the person...') },
        { type: 'input', key: 'profile:username', label: t('label_username', 'Username'), placeholder: t('ph_username', 'Enter the username of the person...') },
        { type: 'input', key: 'profile:gender', label: t('label_gender', 'Gender'), placeholder: t('ph_gender', 'Enter the gender of the person...') }
      ]
    },

    'music.song': {
      name: t('section_song_details', 'Song details'),
      elements: [
        { type: 'input', key: 'music:duration', label: t('label_duration', 'Duration'), placeholder: t('ph_song_duration', 'The duration of the song...') },
        { type: 'input', key: 'music:album', label: t('label_album', 'Album'), placeholder: t('ph_song_album', 'The album this song is from...') },
        { type: 'input', key: 'music:album:disk', label: t('label_disc', 'Disc'), placeholder: t('ph_song_disc', 'Which disc of the album this song is on...') },
        { type: 'input', key: 'music:album:track', label: t('label_track', 'Track'), placeholder: t('ph_song_track', 'Which track this song is...') },
        { type: 'input-multiple', key: 'music:musician', label: t('label_musician', 'Musician'), placeholder: t('ph_song_musician', 'The musician that made this song...') }
      ]
    },

    'music.album': {
      name: t('section_album_details', 'Album details'),
      elements: [
        { type: 'input', key: 'music:song', label: t('label_song', 'Song'), placeholder: t('ph_album_song', 'The song on this album...') },
        { type: 'input', key: 'music:song:disc', label: t('label_disc', 'Disc'), placeholder: t('ph_album_disc', 'The same as music:album:disc but in reverse...') },
        { type: 'input', key: 'music:song:track', label: t('label_track', 'Track'), placeholder: t('ph_album_track', 'The same as music:album:track but in reverse...') },
        { type: 'input', key: 'music:musician', label: t('label_musician', 'Musician'), placeholder: t('ph_song_musician', 'The musician that made this song...') },
        { type: 'input', key: 'music:release_date', label: t('label_release_date', 'Release date'), placeholder: t('ph_album_release_date', 'The date the album was released...') }
      ]
    },

    'music.playlist': {
      name: t('section_playlist_details', 'Playlist details'),
      elements: [
        { type: 'input', key: 'music:song', label: t('label_song', 'Song'), placeholder: t('ph_album_song', 'The song on this album...') },
        { type: 'input', key: 'music:song:disc', label: t('label_disc', 'Disc'), placeholder: t('ph_album_disc', 'The same as music:album:disc but in reverse...') },
        { type: 'input', key: 'music:song:track', label: t('label_track', 'Track'), placeholder: t('ph_album_track', 'The same as music:album:track but in reverse...') },
        { type: 'input', key: 'music:creator', label: t('label_creator', 'Creator'), placeholder: t('ph_playlist_creator', 'The creator of this playlist...') }
      ]
    },

    'music.radio_station': {
      name: t('section_radio_station_details', 'Radio station details'),
      elements: [
        { type: 'input', key: 'music:creator', label: t('label_creator', 'Creator'), placeholder: t('ph_radio_creator', 'The creator of this radio station...') }
      ]
    },

    'video.movie': {
      name: t('section_movie_details', 'Movie details'),
      elements: [
        { type: 'input-multiple', key: 'video:actor', label: t('label_actor', 'Actor'), placeholder: t('ph_actor', 'Name of the actress/actor...') },
        { type: 'input-multiple', key: 'video:director', label: t('label_director', 'Director'), placeholder: t('ph_director', 'Name of the director...') },
        { type: 'input-multiple', key: 'video:writer', label: t('label_writer', 'Writer'), placeholder: t('ph_writer', 'Writers of the movie...') },
        { type: 'input', key: 'video:duration', label: t('label_duration', 'Duration'), placeholder: t('ph_movie_duration', 'The movie length in seconds...') },
        { type: 'input', key: 'video:release_date', label: t('label_release_date', 'Release date'), placeholder: t('ph_movie_release_date', 'The date the movie was released...') },
        { type: 'input', key: 'video:tag', label: t('label_tag', 'Tag'), placeholder: t('ph_movie_tag', 'Tag words associated with this movie...') }
      ]
    },

    'video.episode': {
      name: t('section_episode_details', 'Video episode details'),
      elements: [
        { type: 'input-multiple', key: 'video:actor', label: t('label_actor', 'Actor'), placeholder: t('ph_actor', 'Name of the actress/actor...') },
        { type: 'input-multiple', key: 'video:director', label: t('label_director', 'Director'), placeholder: t('ph_director', 'Name of the director...') },
        { type: 'input-multiple', key: 'video:writer', label: t('label_writer', 'Writer'), placeholder: t('ph_writer', 'Writers of the movie...') },
        { type: 'input', key: 'video:duration', label: t('label_duration', 'Duration'), placeholder: t('ph_movie_duration', 'The movie length in seconds...') },
        { type: 'input', key: 'video:release_date', label: t('label_release_date', 'Release date'), placeholder: t('ph_movie_release_date', 'The date the movie was released...') },
        { type: 'input', key: 'video:tag', label: t('label_tag', 'Tag'), placeholder: t('ph_movie_tag', 'Tag words associated with this movie...') },
        { type: 'input', key: 'video:series', label: t('label_series', 'Series'), placeholder: t('ph_series', 'Which series this episode belongs to...') }
      ]
    },

    'video.tv_show': {
      name: t('section_tv_show_details', 'TV show details'),
      elements: [
        { type: 'input-multiple', key: 'video:actor', label: t('label_actor', 'Actor'), placeholder: t('ph_actor', 'Name of the actress/actor...') },
        { type: 'input-multiple', key: 'video:director', label: t('label_director', 'Director'), placeholder: t('ph_director', 'Name of the director...') },
        { type: 'input-multiple', key: 'video:writer', label: t('label_writer', 'Writer'), placeholder: t('ph_writer', 'Writers of the movie...') },
        { type: 'input', key: 'video:duration', label: t('label_duration', 'Duration'), placeholder: t('ph_movie_duration', 'The movie length in seconds...') },
        { type: 'input', key: 'video:release_date', label: t('label_release_date', 'Release date'), placeholder: t('ph_movie_release_date', 'The date the movie was released...') },
        { type: 'input', key: 'video:tag', label: t('label_tag', 'Tag'), placeholder: t('ph_movie_tag', 'Tag words associated with this movie...') }
      ]
    },

    'video.other': {
      name: t('section_other_video_details', 'Other video details'),
      elements: [
        { type: 'input-multiple', key: 'video:actor', label: t('label_actor', 'Actor'), placeholder: t('ph_actor', 'Name of the actress/actor...') },
        { type: 'input-multiple', key: 'video:director', label: t('label_director', 'Director'), placeholder: t('ph_director', 'Name of the director...') },
        { type: 'input-multiple', key: 'video:writer', label: t('label_writer', 'Writer'), placeholder: t('ph_writer', 'Writers of the movie...') },
        { type: 'input', key: 'video:duration', label: t('label_duration', 'Duration'), placeholder: t('ph_movie_duration', 'The movie length in seconds...') },
        { type: 'input', key: 'video:release_date', label: t('label_release_date', 'Release date'), placeholder: t('ph_movie_release_date', 'The date the movie was released...') },
        { type: 'input', key: 'video:tag', label: t('label_tag', 'Tag'), placeholder: t('ph_movie_tag', 'Tag words associated with this movie...') }
      ]
    }
  };

  /** 三个常驻分区，任何页面类型下都渲染，顺序即输出顺序。 */
  var BASE_SECTIONS = ['website', 'image', 'twitter'];

  /* ---------- 纯逻辑 ---------- */

  /** 页面类型下拉里的全部取值（分组展开），测试与校验共用。 */
  function typeOptionValues() {
    var out = [];
    TYPE_OPTIONS.forEach(function (o) {
      if (o.group) o.options.forEach(function (c) { out.push(c.value); });
      else out.push(o.value);
    });
    return out;
  }

  /** 某个分区里声明的字段 key，按声明顺序。 */
  function sectionKeys(sectionId) {
    var s = SCHEMAS[sectionId];
    return s ? s.elements.map(function (e) { return e.key; }) : [];
  }

  /** 某个页面类型**额外**追加的分区；website 与未知类型都没有额外分区。 */
  function extraSectionId(type) {
    var ty = String(type == null ? '' : type);
    return ty === 'website' ? null : (SCHEMAS[ty] ? ty : null);
  }

  /** 某个页面类型追加的字段 key（只算额外分区，常驻分区不算）。 */
  function keysForType(type) {
    var id = extraSectionId(type);
    return id ? sectionKeys(id) : [];
  }

  /** 当前页面类型下要渲染的分区 id，按输出顺序。 */
  function sectionNames(type) {
    var id = extraSectionId(type);
    return id ? BASE_SECTIONS.concat([id]) : BASE_SECTIONS.slice();
  }

  /**
   * 当前页面类型下，按声明顺序排好的全部字段 key。
   * 只含**当前仍然可见**的字段 —— 上一个类型的残留字段因此不会漏进输出。
   */
  function orderedKeys(type) {
    var keys = [];
    sectionNames(type).forEach(function (id) {
      sectionKeys(id).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    });
    return keys;
  }

  /** 初始状态，与参考实现的 metadata 初值一致。 */
  function defaultMetadata() {
    return { type: 'website', 'twitter:card': 'summary_large_image' };
  }

  /**
   * 切换页面类型时，把刚离开的那个类型的「额外分区」字段清空。
   * 常驻的 website / image / twitter 字段不动 —— 标题、描述、图片在换类型后
   * 通常还是要继续用的（与参考实现清 `ogSchemas[type]` 的范围一致）。
   * 返回新对象，不改传入的那个。
   */
  function clearTypeFields(meta, type) {
    var out = {};
    Object.keys(meta || {}).forEach(function (k) { out[k] = meta[k]; });
    keysForType(type).forEach(function (k) { out[k] = ''; });
    return out;
  }

  /** 元数据必须是普通对象；null/undefined 当空对象，其它类型直接拒绝。 */
  function normalizeMeta(meta) {
    if (meta === null || meta === undefined) return {};
    if (typeof meta !== 'object' || Array.isArray(meta)) {
      throw new TypeError('Metadata must be an object, got ' + (Array.isArray(meta) ? 'array' : typeof meta));
    }
    return meta;
  }

  /**
   * 把扁平的 metadata 拆成 oggen 期望的形状：
   * `twitter:card` 这类前缀键归到嵌套的 twitter 对象下（oggen 会给它补回前缀）。
   * 空值直接丢掉 —— oggen 本来也会跳过，但先滤一遍能保证输出顺序干净。
   */
  function splitMetadata(meta) {
    var src = normalizeMeta(meta);
    var twitter = {}, other = {};
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (v === '' || v === null || v === undefined) return;
      if (k.indexOf('twitter:') === 0) twitter[k.slice('twitter:'.length)] = v;
      else other[k] = v;
    });
    return { other: other, twitter: twitter };
  }

  /**
   * orderedKeys 的顺序 + splitMetadata 的拆分，合成 oggen 的入参。
   * @returns {Object} 形如 {type, title, ..., twitter: {card, site}}
   */
  function buildMeta(meta) {
    var src = normalizeMeta(meta);
    var split = splitMetadata(src);
    var out = {};
    orderedKeys(src.type).forEach(function (k) {
      if (k.indexOf('twitter:') === 0) return;   // 下面统一处理
      if (Object.prototype.hasOwnProperty.call(split.other, k)) out[k] = split.other[k];
    });
    var tw = {};
    orderedKeys(src.type).forEach(function (k) {
      if (k.indexOf('twitter:') !== 0) return;
      var short = k.slice('twitter:'.length);
      if (Object.prototype.hasOwnProperty.call(split.twitter, short)) tw[short] = split.twitter[short];
    });
    if (Object.keys(tw).length) out.twitter = tw;
    return out;
  }

  /** 生成 HTML 标签串。空元数据得到空串。**未修正**，只用来做对照与测试。 */
  function generateTagsRaw(meta) {
    return window.oggen(buildMeta(meta), { generateTwitterCompatibleMeta: true });
  }

  /* ---------- oggen 输出修正（见文件头）---------- */

  /** oggen 对 imgUrl 这个键给出的错误属性名，规范要的是 og:image。 */
  var OG_IMG_URL = 'og:img_url';

  /**
   * `<meta …>` 标签内部的一个「属性名=属性值」。值可以是双引号、单引号或无引号。
   * 引号包裹的整段被一次性吃掉，所以**值里出现的 value="…"/content="…"/property="…"
   * 不会被当成新的属性起点** —— 这是「不做无脑全文替换」的关键。
   */
  var META_ATTR = /^(\s+)([a-zA-Z_:][-a-zA-Z0-9_:.]*)=("[^"]*"|'[^']*'|[^\s"'=<>`]*)/;

  /** 匹配整个 <meta …> 标签；引号区内的 `>` 不会提前截断匹配。 */
  var META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

  /**
   * 修正单个 <meta …> 标签，逐字符扫并跟踪引号状态：
   *   · 属性名位置的 value= → content=
   *   · property 的取值 og:img_url → og:image
   * 属性顺序、引号风格、其它属性一律原样保留；本来就是 content= / og:image 的
   * 什么都不改，所以整条流水线是幂等的。
   */
  function fixMetaTag(tag) {
    var out = '';
    var i = 0;
    while (i < tag.length) {
      var m = META_ATTR.exec(tag.slice(i));
      if (!m) { out += tag.charAt(i); i++; continue; }

      var raw = m[3];
      var quote = raw.charAt(0);
      var quoted = quote === '"' || quote === "'";
      var value = quoted ? raw.slice(1, -1) : raw;

      var name = m[2];
      var lower = name.toLowerCase();
      var newName = name, newValue = value;
      if (lower === 'value') newName = 'content';                       // content= 本身不动 → 幂等
      else if (lower === 'property' && value === OG_IMG_URL) newValue = 'og:image';

      out += m[1] + newName + '=' + (quoted ? quote + newValue + quote : newValue);
      i += m[0].length;
    }
    return out;
  }

  /**
   * 把一段 oggen 输出的 HTML 里的 <meta …> 标签修正成符合 OG 协议的形式。
   * 只进 <meta> 标签内部，外面的一切（含 <!-- 注释 -->）原样保留。
   */
  function fixMetaAttributes(html) {
    return String(html == null ? '' : html).replace(META_TAG, fixMetaTag);
  }

  /** 工具的对外输出：oggen 生成 + 修正。UI 与 copy 按钮都走这里。 */
  function generateTags(meta) {
    return fixMetaAttributes(generateTagsRaw(meta));
  }

  /* ---------- UI ---------- */

  window.ItTools.register('meta-tag-generator', function (root) {
    var state = defaultMetadata();
    var formHost = D.h('div');
    var output = U.codeBlock();
    var countNote = D.h('span.badge-note');

    function render() {
      var html = generateTags(state);
      output.value = html;
      var n = html ? html.split('\n').filter(function (l) { return l.indexOf('<meta') === 0; }).length : 0;
      countNote.textContent = n
        ? (n === 1 ? t('meta_tag_one', '1 meta tag') : t('meta_tags_count', '{count} meta tags').replace('{count}', n))
        : t('fill_fields', 'Fill the fields above');
    }

    function setValue(key, value) {
      state[key] = value;
      render();
    }

    /**
     * 一行元数据 —— 照原版 n-input-group 的样子：
     * 左边一块 110px 宽的标签格子（.input-group-label：带边框的小方块，
     * 文字**左**对齐），右边是控件，两块拼成一行。
     *
     * 原版模板里每个字段都是这个形态：
     *     <n-input-group-label style="flex: 0 0 110px">{{ label }}</n-input-group-label>
     * 那个标签格子是普通单元格（text-align: start），所以列宽写死 110px、
     * 文字靠左 —— 不是 c-label 那种「按文字宽度」的自适应左标签。
     *
     * gap 收成 0：原版的标签格子跟输入框是**贴着**的（naive-ui 靠边框叠 1px
     * 拼成一体），.input-group-label 的右边框本来就省掉了，留着 6px 的 gap
     * 会在格子与输入框之间裂开一条缝。
     *
     * 内边距写 12px（原版 n-input-group-label 的 padding: 0 12px）：输入框的
     * 文字也是从左边 12px 开始，两边的字才对得齐；.input-group-label 默认的
     * 10px 会让标签的字比框里的字往左偏 2px。
     */
    function groupRow(labelText, control, opts) {
      opts = opts || {};
      var style = { gap: '0', marginBottom: '5px' };
      // 多值字段那行的控件比标签格子高，标签格子要**顶**着（align-items: center
      // 会把 34px 的格子居中，跟原版的拉伸对齐对不上）
      if (opts.align) style.alignItems = opts.align;
      return D.h('div.input-group', { style: style },
        D.h('span.input-group-label', { style: { flex: '0 0 110px', padding: '0 12px' }, text: labelText }),
        control);
    }

    /**
     * 多值字段（参考实现里的 n-dynamic-input）：一行一个输入框，能加能删。
     * 每个非空值对应一条同名 meta 标签。
     */
    function multipleField(el) {
      var list = D.h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
      var values = Array.isArray(state[el.key]) ? state[el.key] : [];

      function collect() {
        var rows = list.querySelectorAll('input');
        var out = [];
        Array.prototype.forEach.call(rows, function (r) {
          if (r.value.trim()) out.push(r.value.trim());
        });
        state[el.key] = out;
        render();
      }

      function addRow(value) {
        var input = D.h('input.layui-input', {
          type: 'text', value: value || '', placeholder: el.placeholder || '', spellcheck: 'false'
        });
        input.addEventListener('input', collect);
        var row = D.h('div.input-group', null, input,
          D.h('button.icon-btn', {
            type: 'button', title: t('remove', 'Remove'), 'aria-label': t('remove', 'Remove'), text: '×',
            onclick: function () { row.remove(); collect(); }
          }));
        list.appendChild(row);
      }

      values.forEach(addRow);
      if (!values.length) addRow('');

      // 一组控件共用一个标题，所以这里用 span 而不是 <label for> —— 没有哪个
      // 单独的控件可以被这个标题指认（原版的 n-input-group-label 也是普通 div）
      return groupRow(el.label, D.h('div', {
        style: {
          flex: '1 1 auto', minWidth: '0',
          display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start'
        }
      },
        list,
        D.h('button.layui-btn.layui-btn-sm.layui-btn-primary', {
          type: 'button', text: t('add', '+ Add'), onclick: function () { addRow(''); collect(); }
        })
      ), { align: 'flex-start' });
    }

    /**
     * 控件 id 必须自己给：Author / Duration / Tag / Disc 这些字段在多个分区里
     * 都出现，用字段 key 做 id 才不会撞（撞了同一个 id，点一处聚焦到另一处去）。
     *
     * 标签格子是 span 而不是 <label for>（原版的 n-input-group-label 也是普通
     * 单元格），所以 id 不承担「点标签聚焦控件」这件事，只是页面上唯一而已。
     */
    function fieldId(key) { return 'mtg-' + String(key).replace(/[^a-z0-9]+/gi, '-'); }

    function selectField(el) {
      /* 带上 .layui-select：app.css 里 `select.layui-select` 那条规则会把它
         压到 34px 高（跟文本框一样），原版的 c-select 也是 34px。
         只写 .layui-input 的原生 select 会按 layui 的默认算成 38px，
         那一行就比别行高 4px，把后面所有标签的纵向位置全带偏。 */
      var sel = D.h('select.layui-input.layui-select', { id: fieldId(el.key) }, el.options.map(function (o) {
        if (o.group) {
          return D.h('optgroup', { label: o.group }, o.options.map(function (c) {
            return D.h('option', { value: c.value, text: c.label, selected: c.value === state[el.key] });
          }));
        }
        return D.h('option', { value: o.value, text: o.label, selected: o.value === state[el.key] });
      }));
      sel.addEventListener('change', function () {
        if (el.key === 'type') {
          // 换页面类型：清掉刚离开的类型的字段，再按新类型重建整张表
          state = clearTypeFields(state, state.type);
          state.type = sel.value;
          buildForm();
          render();
        } else {
          setValue(el.key, sel.value);
        }
      });
      return sel;
    }

    function inputField(el) {
      var input = D.h('input.layui-input', {
        id: fieldId(el.key), type: 'text', value: state[el.key] || '',
        placeholder: el.placeholder || '', spellcheck: 'false'
      });
      input.addEventListener('input', function () { setValue(el.key, input.value); });
      return input;
    }

    function buildForm() {
      D.clear(formHost);
      sectionNames(state.type).forEach(function (id) {
        var section = SCHEMAS[id];
        /* 分区间距 20px、分区标题下边距 5px。
           原版是「行 5px + 分区 15px」：<div style="margin-bottom: 15px"> 里
           装着 margin-bottom: 5px 的 n-input-group，而 n-input-group 是
           inline-flex —— 行盒的下边折不跟分区折叠，两个数是**相加**的。
           我们的行是块级 flex，边距会折叠（取大者），所以这里直接把分区的
           下边距写成 20px，间距才跟原版一样。 */
        var block = D.h('div', { style: { marginBottom: '20px' } });
        block.appendChild(D.h('h3.field-label', { text: section.name, style: { margin: '0 0 5px', lineHeight: '1.6' } }));
        section.elements.forEach(function (el) {
          if (el.type === 'input-multiple') { block.appendChild(multipleField(el)); return; }
          var control = el.type === 'select' ? selectField(el) : inputField(el);
          block.appendChild(groupRow(el.label, control));
        });
        formHost.appendChild(block);
      });
    }

    root.appendChild(D.h('div.card', null, formHost));

    // 原版：表单一块、结果一块，结果是「标签 + 卡片里的代码」，
    // 卡片不套在另一张卡里。
    root.appendChild(D.h('div', null,
      D.h('div.field-row', null,
        D.h('label.field-label', { text: t('your_meta_tags', 'Your meta tags') }),
        countNote
      ),
      output.card,
      D.h('p.field-hint', {
        text: t('oggen_hint', 'Generated by @it-tools/oggen and post-processed here: the library writes value="…" where the OG spec asks for content="…", and names the image property og:img_url instead of og:image. Both are corrected below — otherwise no crawler would read these tags.')
      })
    ));

    buildForm();
    render();

    return { destroy: function () { D.clear(root); } };
  });

  /* ---------- 测试用例 ---------- */

  window.ItTools.logic['meta-tag-generator'] = {
    SCHEMAS: SCHEMAS,
    BASE_SECTIONS: BASE_SECTIONS,
    TYPE_OPTIONS: TYPE_OPTIONS,
    typeOptionValues: typeOptionValues,
    sectionKeys: sectionKeys,
    extraSectionId: extraSectionId,
    keysForType: keysForType,
    sectionNames: sectionNames,
    orderedKeys: orderedKeys,
    defaultMetadata: defaultMetadata,
    clearTypeFields: clearTypeFields,
    splitMetadata: splitMetadata,
    buildMeta: buildMeta,
    generateTags: generateTags,
    generateTagsRaw: generateTagsRaw,
    fixMetaAttributes: fixMetaAttributes,
    fixMetaTag: fixMetaTag,
    __cases: function (assert) {
      /* ---- 字段表 ---- */
      assert.eq(typeOptionValues(), [
        'website', 'article', 'book', 'profile',
        'music.song', 'music.album', 'music.playlist', 'music.radio_station',
        'video.movie', 'video.episode', 'video.tv_show', 'video.other'
      ], '12 个页面类型，与参考实现的 typeOptions 一致');
      assert.eq(sectionKeys('twitter'), ['twitter:card', 'twitter:site', 'twitter:creator'], 'Twitter 分区三个字段');
      assert.eq(sectionKeys('image'), ['image', 'image:alt', 'image:width', 'image:height'], 'Image 分区四个字段');
      assert.eq(sectionKeys('bogus'), [], '未知分区没有字段');
      assert(sectionKeys('video.episode').indexOf('video:series') >= 0, '剧集分区多一个 video:series');
      assert(sectionKeys('video.tv_show').indexOf('video:series') < 0, '电视剧分区没有 video:series');
      assert(sectionKeys('music.song').indexOf('music:musician') >= 0, '歌曲分区有 music:musician');
      // 字段表里的 key 必须是小写词 + 可选的多级冒号后缀，否则 oggen 的
      // toSnakeCase 会把它改写成另一个名字，标签就对不上字段表了
      Object.keys(SCHEMAS).forEach(function (id) {
        sectionKeys(id).forEach(function (k) {
          assert(/^[a-z0-9_]+(:[a-z0-9_]+)*$/.test(k), id + ' 的字段名 ' + k + ' 能被 oggen 原样加前缀');
        });
      });
      // 同时可见的分区之间不能有重名字段，否则 id 会撞、值也会互相覆盖
      ['website', 'article', 'book', 'profile', 'music.song', 'music.album',
        'music.playlist', 'music.radio_station', 'video.movie', 'video.episode',
        'video.tv_show', 'video.other'].forEach(function (type) {
        var all = sectionNames(type).reduce(function (acc, id) { return acc.concat(sectionKeys(id)); }, []);
        assert.eq(all.length, all.filter(function (k, i) { return all.indexOf(k) === i; }).length,
          '类型 ' + type + ' 下没有重名字段');
      });

      /* ---- 分区选择 ---- */
      assert.eq(sectionNames('website'), ['website', 'image', 'twitter'], 'website 只有三个常驻分区');
      assert.eq(sectionNames('article'), ['website', 'image', 'twitter', 'article'], 'article 追加一个分区');
      assert.eq(sectionNames('bogus'), ['website', 'image', 'twitter'], '未知类型不崩，退回三个常驻分区');
      assert.eq(extraSectionId('website'), null, 'website 没有额外分区');
      assert.eq(extraSectionId('video.movie'), 'video.movie', 'video.movie 有额外分区');
      assert.eq(keysForType('website'), [], 'website 的额外字段为空');
      assert.eq(keysForType('book'), ['book:author', 'book:isbn', 'book:release_date', 'book:tag'], '书籍的额外字段');
      assert.eq(orderedKeys('website').slice(0, 4), ['type', 'title', 'description', 'url'], '常驻字段在前');
      assert(orderedKeys('article').indexOf('article:author') >= 4, '额外字段排在常驻字段之后');

      /* ---- 初值与拆分 ---- */
      assert.eq(defaultMetadata(), { type: 'website', 'twitter:card': 'summary_large_image' }, '初值与参考实现一致');
      assert.eq(splitMetadata({ type: 'website', 'twitter:card': 'summary', title: 'T' }),
        { other: { type: 'website', title: 'T' }, twitter: { card: 'summary' } }, 'twitter: 前缀归到嵌套对象');
      assert.eq(splitMetadata({}), { other: {}, twitter: {} }, '空对象');
      assert.eq(splitMetadata(null), { other: {}, twitter: {} }, 'null 当空对象，不炸');
      assert.eq(splitMetadata({ title: '', description: null, url: undefined, image: 'x' }),
        { other: { image: 'x' }, twitter: {} }, '空值被滤掉');

      /* ---- 切类型时清字段 ---- */
      var m = { type: 'article', title: 'T', 'article:author': 'me', 'article:tag': 'x' };
      var cleared = clearTypeFields(m, 'article');
      assert.eq(sectionKeys('article').filter(function (k) { return cleared[k] !== ''; }), [],
        '整个分区的字段都被清空（与参考实现的 watch 逐个 key 置空一致）');
      assert.eq(cleared.title, 'T', '常驻的 title 字段不动 —— 换类型后标题通常还要继续用');
      assert.eq(cleared.type, 'article', 'type 自己也不动（调用方随后才改成新类型）');
      assert.eq(m['article:author'], 'me', '不改传入的对象');
      assert.eq(clearTypeFields({ type: 'website', title: 'T' }, 'website'), { type: 'website', title: 'T' },
        'website 没有额外字段，清了等于没清（标题要留着换类型继续用）');

      /* ---- buildMeta：顺序与嵌套 ---- */
      assert.eq(buildMeta({
        type: 'website', title: 'T', description: 'D', url: 'https://a.b',
        image: 'https://i.png', 'image:alt': 'alt', 'image:width': '120', 'image:height': '60',
        'twitter:card': 'summary', 'twitter:site': '@ittoolsdottech'
      }), {
        type: 'website', title: 'T', description: 'D', url: 'https://a.b',
        image: 'https://i.png', 'image:alt': 'alt', 'image:width': '120', 'image:height': '60',
        twitter: { card: 'summary', site: '@ittoolsdottech' }
      }, '拆成 oggen 的入参，twitter 收进嵌套对象');

      assert.eq(buildMeta({}), {}, '空元数据得到空入参');
      assert.eq(buildMeta({ twitter: { card: 'summary' } }), {}, '没有 twitter: 前缀的键不会被误收（参考实现靠前缀区分）');
      assert(buildMeta({ type: 'website', title: 'T', 'twitter:card': '' }).twitter === undefined,
        'twitter 全空时不产生 twitter 对象');

      /* ---- generateTagsRaw：oggen 的原始输出（未修正，仅作对照）---- */
      assert.eq(generateTagsRaw({ type: 'website', title: 'T' }),
        '<!-- og meta -->\n<meta property="og:type" value="website" />\n' +
        '<meta property="og:title" value="T" />\n\n' +
        '<!-- twitter meta -->\n<meta name="twitter:title" value="T" />',
        'oggen 原样输出确实是 value=（这就是要修的 bug）');

      /* ---- generateTags：修正后的输出 ---- */
      assert.eq(generateTags({}), '', '空元数据得到空串');
      assert.eq(generateTags(null), '', 'null 得到空串');
      assert.eq(generateTags({ type: 'website', 'twitter:card': 'summary' }),
        '<!-- og meta -->\n<meta property="og:type" content="website" />\n\n' +
        '<!-- twitter meta -->\n<meta name="twitter:card" content="summary" />',
        '只有类型与卡片类型时的完整输出，value 已改回 content');

      var full = generateTags({
        type: 'website', title: 'My title', description: 'My description', url: 'https://a.b',
        image: 'https://i.png', 'image:alt': 'alt', 'image:width': '120', 'image:height': '60',
        'twitter:card': 'summary_large_image', 'twitter:site': '@ittoolsdottech', 'twitter:creator': '@cthmsst'
      });
      assert.eq(full,
        '<!-- og meta -->\n' +
        '<meta property="og:type" content="website" />\n' +
        '<meta property="og:title" content="My title" />\n' +
        '<meta property="og:description" content="My description" />\n' +
        '<meta property="og:url" content="https://a.b" />\n' +
        '<meta property="og:image" content="https://i.png" />\n' +
        '<meta property="og:image:alt" content="alt" />\n' +
        '<meta property="og:image:width" content="120" />\n' +
        '<meta property="og:image:height" content="60" />\n' +
        '\n' +
        '<!-- twitter meta -->\n' +
        '<meta name="twitter:card" content="summary_large_image" />\n' +
        '<meta name="twitter:site" content="@ittoolsdottech" />\n' +
        '<meta name="twitter:creator" content="@cthmsst" />\n' +
        '<meta name="twitter:title" content="My title" />\n' +
        '<meta name="twitter:description" content="My description" />\n' +
        '<meta name="twitter:image" content="https://i.png" />\n' +
        '<meta name="twitter:image:alt" content="alt" />',
        '全字段输出：og 一组、twitter 一组，content 已改对，且 twitter 补齐了 og 的 title/description/image');
      assert(full.indexOf('value=') < 0, '修正后的输出里不该再有任何 value=');

      // generateTwitterCompatibleMeta：og 有而 twitter 没有的，会被补一份 twitter
      assert(generateTags({ type: 'website', title: 'T' }).indexOf('<meta name="twitter:title" content="T" />') > 0,
        'og:title 自动补成 twitter:title');
      assert(generateTags({ type: 'website', image: 'https://i.png' })
        .indexOf('<meta name="twitter:image" content="https://i.png" />') > 0, 'og:image 自动补成 twitter:image');
      assert(generateTags({ type: 'website', image: 'https://i.png' }).indexOf('og:image:url') < 0,
        'twitterCompatibility 表里有 og:image:url，但表里没有这个字段，不该出现');

      // 换类型后，旧类型的字段不能再出现（顺序表天然挡住，比参考实现的「靠 watch 清空」可靠）
      assert(generateTags({ type: 'book', 'article:author': 'me', 'book:isbn': '978' })
        .indexOf('article:author') < 0, 'article 的残留字段不会漏进 book 的输出');
      assert(generateTags({ type: 'book', 'article:author': 'me', 'book:isbn': '978' })
        .indexOf('og:book:isbn') > 0, 'book 的字段正常输出');

      // 多值字段 → 同名标签出现多次
      var actors = generateTags({ type: 'video.movie', 'video:actor': ['Alice', 'Bob'], 'video:duration': '120' });
      assert.eq(actors.split('<meta property="og:video:actor"').length - 1, 2, '两个演员出两条标签');
      assert(actors.indexOf('<meta property="og:video:duration" content="120" />') > 0, '同分区里的单值字段也在');
      assert(generateTags({ type: 'music.song', 'music:musician': [] }).indexOf('music:musician') < 0,
        '空数组不出标签');
      assert(generateTags({ type: 'music.song', 'music:musician': [''] }).indexOf('music:musician') < 0,
        '数组里的空串也不出标签');

      // 类型名里的点必须原样落到属性名上
      assert(generateTags({ type: 'music.song', 'music:album': 'OK' }).indexOf('<meta property="og:type" content="music.song" />') > 0,
        'music.song 这类带点的类型值原样输出');
      assert(generateTags({ type: 'video.episode', 'video:series': 'S1' }).indexOf('og:video:series') > 0,
        '多级冒号键照原样输出');

      /* ---- fixMetaAttributes：oggen 输出的后处理 ---- */

      // 1) 单个 og 标签
      assert.eq(fixMetaAttributes('<meta property="og:title" value="T" />'),
        '<meta property="og:title" content="T" />', '单个 og 标签：value= → content=');

      // 2) oggen 对 imgUrl 这个键给出的 og:img_url 改回 og:image
      assert.eq(fixMetaAttributes('<meta property="og:img_url" value="https://i.png" />'),
        '<meta property="og:image" content="https://i.png" />', 'og:img_url → og:image');
      // 本工具的 website/image 分区用的是 image 这个键，snake_case 之后正好是 og:image，
      // 碰不到 img_url。但 oggen 公开的键表里 imgUrl → og:img_url 是存在的（实测
      // oggen({imgUrl}) 确实吐 og:img_url），所以这层映射留着当兜底：将来加了用
      // imgUrl 的字段（或换库版本），也不会漏一个不合规的属性名出去。
      assert(generateTags({ type: 'website', image: 'https://i.png' })
        .indexOf('<meta property="og:image" content="https://i.png" />') > 0,
        '本工具自己的 image 字段本来就落在 og:image 上');
      assert(generateTags({ type: 'website', imgUrl: 'https://i.png' }).indexOf('img_url') < 0,
        'imgUrl 不在字段表里，会被 buildMeta 挡掉，og:img_url 到不了输出');
      // 就算它到了（比如直接用 oggen、或将来放宽白名单），后处理也能救回来
      assert.eq(fixMetaAttributes('<meta property="og:img_url" value="https://i.png" />\n<meta property="og:title" value="T" />'),
        '<meta property="og:image" content="https://i.png" />\n<meta property="og:title" content="T" />',
        'img_url 落到输出层时会被改回 og:image');
      // 只有 og:img_url 这一个取值会被改，同前缀的别的一律不动
      assert.eq(fixMetaAttributes('<meta property="og:image:width" value="120" />'),
        '<meta property="og:image:width" content="120" />', 'og:image:width 不受影响');
      assert.eq(fixMetaAttributes('<meta property="og:img_url_x" value="1" />'),
        '<meta property="og:img_url_x" content="1" />', '只精确匹配 og:img_url');
      assert.eq(fixMetaAttributes('<meta name="twitter:image" value="x" />'),
        '<meta name="twitter:image" content="x" />', 'twitter:image 不是 og:img_url，原样');

      // 3) og + twitter 组合输出：两组的标签都要被改，且顺序/注释不受影响
      assert.eq(fixMetaAttributes(
        '<!-- og meta -->\n<meta property="og:title" value="T" />\n\n' +
        '<!-- twitter meta -->\n<meta name="twitter:card" value="summary" />'),
        '<!-- og meta -->\n<meta property="og:title" content="T" />\n\n' +
        '<!-- twitter meta -->\n<meta name="twitter:card" content="summary" />',
        'og + twitter 组合：注释与分组原样保留，两组标签都改对');

      // 4) 幂等：跑两遍结果一样（以后换库版本也不会越改越坏）
      var once = fixMetaAttributes('<meta property="og:img_url" value="https://i.png" />');
      assert.eq(fixMetaAttributes(once), once, '幂等：第二遍不再改动');
      assert.eq(fixMetaAttributes(generateTagsRaw({ type: 'website', title: 'T', imgUrl: 'https://i.png' })),
        generateTags({ type: 'website', title: 'T', imgUrl: 'https://i.png' }),
        'generateTags 等价于「修一遍」');
      assert.eq(fixMetaAttributes(generateTags({ type: 'website', title: 'T', imgUrl: 'https://i.png' })),
        generateTags({ type: 'website', title: 'T', imgUrl: 'https://i.png' }),
        '整条流水线对生成结果幂等');

      // 5) 已经是 content= / og:image 的必须原样不动
      assert.eq(fixMetaAttributes('<meta property="og:title" content="T" />'),
        '<meta property="og:title" content="T" />', '本来就是 content= 的不动');
      assert.eq(fixMetaAttributes('<meta name="twitter:card" content="summary" />'),
        '<meta name="twitter:card" content="summary" />', 'twitter 组的 content= 也不动');
      assert.eq(fixMetaAttributes('<meta property="og:image" content="https://i.png" />'),
        '<meta property="og:image" content="https://i.png" />', '本来就是 og:image 的不动');
      assert.eq(fixMetaAttributes('<meta charset="utf-8" />'), '<meta charset="utf-8" />',
        '没有 content/value 的标签原样保留');
      assert.eq(fixMetaAttributes('<meta name="description" content="a value=b" />'),
        '<meta name="description" content="a value=b" />', '值里的 value= 不是属性，不动');

      // 6) 关键：**不能**被无脑全文替换误伤 —— 属性值里出现字面量 value="…" 时，
      //    只有属性名位置的那一个该被改
      assert.eq(fixMetaAttributes('<meta property="og:title" value="tip: use value=&quot;x&quot; here" />'),
        '<meta property="og:title" content="tip: use value=&quot;x&quot; here" />',
        '值里的 value=&quot;…&quot; 原样保留，只改属性名那一个');
      assert.eq(fixMetaAttributes('<meta property="og:description" value="a value=b c content=d" />'),
        '<meta property="og:description" content="a value=b c content=d" />',
        '值里同时出现 value= 与 content= 时都不动');
      // oggen 不转义值，标题里带裸引号会把标签提前截断；这时也只改属性名那一个
      assert.eq(fixMetaAttributes('<meta property="og:title" value="say value="x" now" />'),
        '<meta property="og:title" content="say value="x" now" />',
        '值里有裸引号时不会误伤第二个 value=');
      // meta 标签之外的一切都不许动
      assert.eq(fixMetaAttributes('<!-- keep value="x" -->\n<p>value="y" content="z"</p>'),
        '<!-- keep value="x" -->\n<p>value="y" content="z"</p>', 'meta 标签之外原样保留');
      assert.eq(fixMetaAttributes('<div data-value="x">value="y"</div>'),
        '<div data-value="x">value="y"</div>', '带 data-value 的非 meta 标签不动');
      assert.eq(fixMetaAttributes('<metadata value="x" />'), '<metadata value="x" />',
        '不是 <meta …> 的标签名不匹配（<meta\b 要求词边界）');

      // 7) 引号风格与属性顺序保持原样
      assert.eq(fixMetaAttributes("<meta property='og:title' value='T' />"),
        "<meta property='og:title' content='T' />", '单引号保持单引号');
      assert.eq(fixMetaAttributes('<meta value="T" property="og:title" />'),
        '<meta content="T" property="og:title" />', '属性顺序保持不变');
      assert.eq(fixMetaAttributes('<meta   property="og:title"    value="T" />'),
        '<meta   property="og:title"    content="T" />', '空白原样保留');
      assert.eq(fixMetaAttributes('<meta property=og:title value=T />'),
        '<meta property=og:title content=T />', '无引号的值也能改');

      // 8) 边界
      assert.eq(fixMetaAttributes(''), '', '空串');
      assert.eq(fixMetaAttributes(null), '', 'null 当空串');
      assert.eq(fixMetaAttributes(undefined), '', 'undefined 当空串');
      assert.eq(fixMetaAttributes('no meta tags here'), 'no meta tags here', '没有 meta 标签时原样返回');
      assert.eq(fixMetaTag('<meta value="T" />'), '<meta content="T" />', 'fixMetaTag 接受裸标签');
      assert.eq(fixMetaAttributes('<meta property="og:title" value="a > b" />'),
        '<meta property="og:title" content="a > b" />', '值里有 > 时标签匹配不被提前截断');

      /* ---- 非法输入 ---- */
      [42, 'website', true, ['a']].forEach(function (bad, i) {
        var threw = false;
        try { generateTags(bad); } catch (e) { threw = true; }
        assert(threw, '非对象的元数据应被拒绝（样本' + i + '：' + JSON.stringify(bad) + '）');
      });
      // 未知类型不崩，只是退回到三个常驻分区
      assert(generateTags({ type: 'nope', title: 'T' }).indexOf('<meta property="og:type" content="nope" />') > 0,
        '未知页面类型不崩');
    }
  };
})();