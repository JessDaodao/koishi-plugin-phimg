import { Context, Schema, segment, User } from 'koishi'
import axios from 'axios'
import { randomInt } from 'crypto'
export const inject = ['database']

declare module 'koishi' {
  interface Tables {
    phimg_config: GroupConfig
  }

  interface User {
    authority: number
  }
}

export interface Config {
  apiKey: string
  apiUrl: string
  defaultTags: string[]
  enabledByDefault: boolean
  useGlobalTagsByDefault: boolean
}


export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().description('Philomena API 密钥').default(''),
  apiUrl: Schema.string().description('Philomena API 链接').default('https://derpibooru.org/api/v1/json/search/images?'),
  defaultTags: Schema.array(String).description('全局标签').default(['safe']),
  enabledByDefault: Schema.boolean().description('默认启用搜图功能').default(true),
  useGlobalTagsByDefault: Schema.boolean().description('默认启用全局标签').default(true),
})

interface GroupConfig extends Record<string, any> {
  id?: number
  groupId: string
  enabled: boolean
  useGlobalTags: boolean
  customTags: string[]
  [Symbol.iterator]?: never
}

export function apply(ctx: Context, config: Config) {
  if (!ctx.database) {
    ctx.logger.warn('数据库未启用，无法使用Phimg')
    return
  }
  
  ctx.model.extend('phimg_config', {
    id: 'unsigned',
    groupId: 'string',
    enabled: 'boolean',
    useGlobalTags: 'boolean',
    customTags: 'list',
  }, {
    autoInc: true,
    primary: 'id',
    unique: ['groupId'],
  })

  const getGroupConfig = async (groupId: string): Promise<GroupConfig> => {
    const [groupConfig] = await ctx.database.get('phimg_config', { groupId })
    if (groupConfig) return groupConfig
  
    const defaultConfig = {
      groupId,
      enabled: config.enabledByDefault,
      useGlobalTags: config.useGlobalTagsByDefault,
      customTags: []
    }
  
    await ctx.database.create('phimg_config', defaultConfig)
    return defaultConfig
  }

  const updateGroupConfig = async (groupId: string, data: Partial<GroupConfig>) => {
    await ctx.database.set('phimg_config', { groupId }, data)
  }

  const searchImages = async (tags: string[], apiKey: string) => {
    const queryParams = new URLSearchParams()
    queryParams.append('q', tags.join(','))
    if (apiKey) queryParams.append('key', apiKey)
    queryParams.append('sf', 'score')
    queryParams.append('sd', 'desc')
    queryParams.append('per_page', '50')

    const url = `${config.apiUrl}${queryParams.toString()}`
    
    try {
      const response = await axios.get(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Phimg for Koishi'
        },
        timeout: 30000
      })

      if (response.data.total === 0) {
        throw new Error('未找到匹配的图片')
      }

      return response.data.images
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error('未找到匹配的图片')
      }
      throw new Error(error.message)
    }
  }

  const selectRandomImage = (images: any[]) => {
    const index = randomInt(0, images.length)
    const selected = images[index]
    const file = selected.representations.full

    return {
      url: file.endsWith('.webm') ? selected.representations.medium : selected.representations.large,
      score: selected.score,
      id: selected.id,
      tags: selected.tags
    }
  }

  const helpMessage = `用法: 搜图 [--add [&lt;tags&gt; ...]] [--rm [&lt;tags&gt; ...]] [--tags] [--on] [--off] [--status] [--onglobal] [--offglobal] [&lt;tags&gt;]
选项:
  --add [&lt;tags&gt; ...]       添加标签，多个标签用逗号分隔
  --rm [&lt;tags&gt; ...]        删除标签，多个标签用逗号分隔
  --tags            查看当前标签列表
  --on              开启搜图功能
  --off             关闭搜图功能
  --onglobal        启用全局标签
  --offglobal       禁用全局标签
  --status          查看当前设置
—————
Powered by
Phimg for Koishi @ CyanFlow`

  ctx.command('搜图 <tags:text>', '从图站搜索图片')
    .option('add', '--add <tags:text> 添加标签')
    .option('rm', '--rm <tags:text> 删除标签')
    .option('tags', '--tags 查看当前标签列表')
    .option('on', '--on 开启搜图功能')
    .option('off', '--off 关闭搜图功能')
    .option('onglobal', '--onglobal 启用全局标签')
    .option('offglobal', '--offglobal 禁用全局标签')
    .option('status', '--status 查看当前设置')
    .action(async ({ session, options }, tags) => {
      if (!session?.guildId) return '搜图功能仅限群聊使用'

      const groupId = session.guildId
      const groupConfig = await getGroupConfig(groupId)

      if (!tags && Object.keys(options).length === 0) {
        return helpMessage
      }

      interface AuthUser {
        authority?: number
      }

      const user = session.user as AuthUser | undefined

      if (options.status) {
        return `当前群聊搜图功能状态：
启用: ${groupConfig.enabled}
自定义标签: ${groupConfig.customTags.join(', ') || '无'}
全局标签: ${groupConfig.useGlobalTags ? '启用' : '禁用'}`
      }

      if (options.on || options.off) {
        if ((user?.authority ?? 0) < 2) {
          return '只有管理员可以修改搜图设置'
        }
        const enabled = options.on ? true : false
        await updateGroupConfig(groupId, { enabled })
        return `搜图功能已在本群${enabled ? '开启' : '关闭'}`
      }

      if (!groupConfig.enabled) {
        return '搜图未在本群开启，管理员请用 “搜图 --on” 启动'
      }

      if (options.onglobal || options.offglobal) {
        if ((user?.authority ?? 0) < 2) {
          return '只有管理员可以修改全局标签设置'
        }
        const useGlobalTags = options.onglobal ? true : false
        await updateGroupConfig(groupId, { useGlobalTags })
        return `全局标签已${useGlobalTags ? '启用' : '禁用'}`
      }

      if (options.add || options.rm) {
        if ((user?.authority ?? 0) < 2) {
          return '只有管理员可以管理标签'
        }

        const tagsToModify = (options.add || options.rm).split(',').map(t => t.trim()).filter(t => t)
        
        if (options.add) {
          const newTags = [...new Set([...groupConfig.customTags, ...tagsToModify])]
          await updateGroupConfig(groupId, { customTags: newTags })
          return `添加成功，本群标签现为: ${newTags.join(', ') || '无'}`
        } else {
          const newTags = groupConfig.customTags.filter(t => !tagsToModify.includes(t))
          await updateGroupConfig(groupId, { customTags: newTags })
          return `删除成功，本群标签现为: ${newTags.join(', ') || '无'}`
        }
      }

      if (options.tags) {
        return `当前群聊内置标签: ${groupConfig.customTags.join(', ') || '无'}`
      }

      if (!tags) {
        return helpMessage
      }

      const userTags = tags ? tags.split(',').map(t => t.trim()).filter(t => t) : []
      const globalTags = groupConfig.useGlobalTags ? config.defaultTags : []
      const groupTags = groupConfig.customTags
      
      const allTags = [...new Set([...globalTags, ...groupTags, ...userTags])]
      
      try {
        const images = await searchImages(allTags, config.apiKey)
        const selected = selectRandomImage(images)
        
        const infoText = `id: ${selected.id}\nscore: ${selected.score}\ntags: ${allTags.join(', ')}`
        
        if (selected.url.endsWith('.webm')) {
          return segment.video(selected.url)
        } else {
          return segment.image(selected.url) + '\n' + infoText
        }
      } catch (error) {
        return error.message
      }
    })
}